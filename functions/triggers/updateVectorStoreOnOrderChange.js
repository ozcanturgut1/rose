import { onDocumentWritten } from "firebase-functions/v2/firestore";
import admin from "firebase-admin";
import OpenAI from "openai";
import dotenv from "dotenv";
import fetch from "node-fetch";
import fs from "fs";
import os from "os";
import path from "path";

dotenv.config();
if (!admin.apps.length) admin.initializeApp();
const db = admin.firestore();
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const VECTOR_STORE_ID = "vs_682212f15ac081919cf34d1b0a8654c1";
const AUTH_HEADERS = { "Authorization": `Bearer ${process.env.OPENAI_API_KEY}` };

export const onOrderChange = onDocumentWritten(
  "orders/{docId}",
  async (event) => {
    const { before, after } = event.data;
    const docId = event.params.docId;

        // --- EARLY EXIT: ignore vector file-ID churn ---
    const IGNORE = ["vectorJsonFileId", "vectorMdFileId"];
    const strip = (d = {}) => {
      const c = { ...d };
      IGNORE.forEach((k) => delete c[k]);
      return c;
    };
    const beforeClean = strip(before.exists ? before.data() : {});
    const afterClean  = strip(after.exists ? after.data()  : {});
    if (JSON.stringify(beforeClean) === JSON.stringify(afterClean)) {
      // only the file-ID fields changed → don’t re-run the sync
      return;
    }
    // --- /EARLY EXIT ---

    // Helper to delete a file from the Vector Store
    async function deleteVectorFile(fileId) {
      if (!fileId) return;
      await fetch(
        `https://api.openai.com/v1/vector_stores/${VECTOR_STORE_ID}/files/${fileId}`,
        { method: "DELETE", headers: AUTH_HEADERS }
      );
    }

    try {
      // If the order was deleted, remove its vector files and exit
      if (!after.exists) {
        const old = before.data();
        await Promise.all([
          deleteVectorFile(old.vectorJsonFileId),
          deleteVectorFile(old.vectorMdFileId),
        ]);
        return;
      }

      // For create or update: fetch new data and previous file-IDs
      const newData = after.data();
      const oldData = before.exists ? before.data() : {};
      const toDelete = [
        oldData.vectorJsonFileId,
        oldData.vectorMdFileId,
      ].filter(Boolean);

      // Remove any stale vector files
      await Promise.all(toDelete.map(deleteVectorFile));

      // 1) Write JSON to temp file and upload
      const tmpJsonPath = path.join(os.tmpdir(), `${docId}.json`);
      fs.writeFileSync(tmpJsonPath, JSON.stringify(newData, null, 2));
      const jsonFile = await openai.files.create({
        file: fs.createReadStream(tmpJsonPath),
        purpose: "user_data",
      });
      await fetch(
        `https://api.openai.com/v1/vector_stores/${VECTOR_STORE_ID}/files`,
        {
          method: "POST",
          headers: { ...AUTH_HEADERS, "Content-Type": "application/json" },
          body: JSON.stringify({ file_id: jsonFile.id }),
        }
      );

      // 2) Write Markdown to temp file and upload
      const tmpMdPath = path.join(os.tmpdir(), `${docId}.md`);
      const mdContent = [
        `# Order ${docId}`,
        "",
        "```json",
        JSON.stringify(newData, null, 2),
        "```",
      ].join("\n");
      fs.writeFileSync(tmpMdPath, mdContent);
      const mdFile = await openai.files.create({
        file: fs.createReadStream(tmpMdPath),
        purpose: "user_data",
      });
      await fetch(
        `https://api.openai.com/v1/vector_stores/${VECTOR_STORE_ID}/files`,
        {
          method: "POST",
          headers: { ...AUTH_HEADERS, "Content-Type": "application/json" },
          body: JSON.stringify({ file_id: mdFile.id }),
        }
      );

      // 3) Update Firestore with the new file-IDs
      await db.collection("orders").doc(docId).set(
        {
          vectorJsonFileId: jsonFile.id,
          vectorMdFileId: mdFile.id,
        },
        { merge: true }
      );
      fs.unlinkSync(tmpJsonPath);
      fs.unlinkSync(tmpMdPath);
    } catch (err) {
      console.error(
        `Error updating Vector Store for order ${docId}:`,
        err
      );
    }
  }
);