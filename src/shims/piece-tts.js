// Piece: chrome.tts implemented with the Web Speech API (speechSynthesis), which Firefox
// background pages and extension pages have.
{
  const synth = globalThis.speechSynthesis;
  if (synth && typeof SpeechSynthesisUtterance === "function") {
    const loadVoices = async () => {
      let vs = synth.getVoices();
      if (!vs.length) {
        await new Promise((r) => { synth.addEventListener("voiceschanged", r, { once: true }); setTimeout(r, 1500); });
        vs = synth.getVoices();
      }
      return vs;
    };
    defineApi("tts", {
      speak: cbify(async (text, options = {}) => {
        if (!options.enqueue) synth.cancel();
        const u = new SpeechSynthesisUtterance(String(text));
        if (options.lang) u.lang = options.lang;
        if (options.rate != null) u.rate = options.rate;
        if (options.pitch != null) u.pitch = options.pitch;
        if (options.volume != null) u.volume = options.volume;
        if (options.voiceName) {
          const v = (await loadVoices()).find((x) => x.name === options.voiceName);
          if (v) u.voice = v;
        }
        const send = (type, extra) => {
          if (typeof options.onEvent === "function") {
            try { options.onEvent(Object.assign({ type, charIndex: 0 }, extra)); } catch (e) { console.error(e); }
          }
        };
        u.onstart = () => send("start");
        u.onend = () => send("end", { charIndex: String(text).length });
        u.onpause = () => send("pause");
        u.onresume = () => send("resume");
        u.onboundary = (e) => send(e.name === "sentence" ? "sentence" : "word", { charIndex: e.charIndex, length: e.charLength });
        u.onerror = (e) => send(e.error === "interrupted" || e.error === "canceled" ? "interrupted" : "error", { errorMessage: e.error });
        synth.speak(u);
      }),
      stop: () => synth.cancel(),
      pause: () => synth.pause(),
      resume: () => synth.resume(),
      isSpeaking: cbify(async () => synth.speaking),
      getVoices: cbify(async () => (await loadVoices()).map((v) => ({
        voiceName: v.name, lang: v.lang, remote: !v.localService,
        eventTypes: ["start", "end", "word", "sentence", "interrupted", "error", "pause", "resume"],
      }))),
      onEvent: stubEvent(),
      onVoicesChanged: stubEvent(),
      EventType: { START: "start", END: "end", WORD: "word", SENTENCE: "sentence", MARKER: "marker", INTERRUPTED: "interrupted", CANCELLED: "cancelled", ERROR: "error", PAUSE: "pause", RESUME: "resume" },
    });
  }
}
