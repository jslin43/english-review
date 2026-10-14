export function localEnglishVoices(synthesis = globalThis.speechSynthesis) {
  if (!synthesis?.getVoices) return [];
  return synthesis.getVoices().filter(voice => voice.localService === true && /^en(?:-|_|$)/i.test(voice.lang));
}

export function stopSpeaking(synthesis = globalThis.speechSynthesis) {
  synthesis?.cancel();
}

export function speakEnglish(text, notify, environment = globalThis) {
  const synthesis = environment.speechSynthesis;
  if (!synthesis || !environment.SpeechSynthesisUtterance) {
    notify("此瀏覽器不支援朗讀，請改用支援系統語音的瀏覽器。", true);
    return false;
  }
  let voices;
  try {
    voices = localEnglishVoices(synthesis);
  } catch (error) {
    notify(`無法讀取裝置語音：${error.message}。`, true);
    return false;
  }
  if (!voices.length) {
    notify("尚無可用的離線英文語音。請在裝置系統的語音／朗讀設定下載英文語音後重試；本程式不使用線上發音服務。", true);
    return false;
  }
  const utterance = new environment.SpeechSynthesisUtterance(String(text).trim());
  utterance.voice = voices.find(voice => voice.lang.toLowerCase() === "en-us") || voices[0];
  utterance.lang = utterance.voice.lang;
  utterance.rate = 0.85;
  utterance.onerror = event => {
    if (!["canceled", "interrupted"].includes(event.error)) notify(`朗讀失敗：${event.error || "系統語音不可用"}。`, true);
  };
  try {
    synthesis.cancel();
    synthesis.speak(utterance);
    return true;
  } catch (error) {
    notify(`無法啟動朗讀：${error.message}。`, true);
    return false;
  }
}
