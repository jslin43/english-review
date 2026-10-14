import { ingestCSV } from "./data.js";

self.onmessage = ({ data }) => {
  try {
    self.postMessage({ cards: ingestCSV(data.text, data.kind) });
  } catch (error) {
    self.postMessage({ error: error?.message || "CSV 匯入失敗。" });
  }
};
