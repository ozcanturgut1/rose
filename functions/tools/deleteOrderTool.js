import { getFirestore } from "firebase-admin/firestore";

export const deleteOrderToolDefinition = {
  type: "function",
  function: {
    name: "deleteOrder",
    description: "Belirli bir Firestore belgesini siler.",
    parameters: {
      type: "object",
      properties: {
        docId: { type: "string", description: "Silinecek belge ID" }
      },
      required: ["docId"]
    }
  }
};

export async function handleDeleteOrder(args) {
  const db = getFirestore();
  await db.collection("orders").doc(args.docId).delete();
  return `Belge ${args.docId} başarıyla silindi.`;
}
