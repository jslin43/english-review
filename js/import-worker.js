import { ingestCSV, ingestCSVFile } from "./data.js";

const reportError = error => {
  const message = error?.message || "CSV 匯入失敗，請檢查檔案格式後重試。";
  self.postMessage({ error: `${error?.name && error.name !== "Error" ? error.name + ": " : ""}${message}` });
};

self.onmessageerror = () => reportError(new Error("無法讀取匯入訊息，請重新選擇 CSV 檔案。"));
self.onmessage = async ({ data }) => {
  try {
    const cards = data?.file ? await ingestCSVFile(data.file, data.kind) : ingestCSV(data?.text, data?.kind);
    self.postMessage({ cards });
  } catch (error) {
    reportError(error);
  }
};
