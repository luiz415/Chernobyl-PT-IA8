const NOTIFICATION_SOUND_KEY = "tibia_notify_sound";

let sharedAudioContext: AudioContext | null = null;
let unlocked = false;

export function loadNotificationSoundPref(): boolean {
  try {
    const raw = localStorage.getItem(NOTIFICATION_SOUND_KEY);
    return raw !== null ? JSON.parse(raw) !== false : true;
  } catch {
    return true;
  }
}

export function saveNotificationSoundPref(value: boolean): void {
  try {
    localStorage.setItem(NOTIFICATION_SOUND_KEY, JSON.stringify(value));
    window.dispatchEvent(new Event("storage"));
  } catch {}
}

function getAudioContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  try {
    const AudioContextCtor = window.AudioContext || (window as any).webkitAudioContext;
    if (!AudioContextCtor) return null;
    if (!sharedAudioContext || sharedAudioContext.state === "closed") {
      sharedAudioContext = new AudioContextCtor();
    }
    return sharedAudioContext;
  } catch {
    return null;
  }
}

function unlockAudio() {
  if (unlocked) return;
  const ctx = getAudioContext();
  if (!ctx) return;
  ctx.resume().then(() => { unlocked = true; }).catch(() => {});
}

if (typeof window !== "undefined") {
  window.addEventListener("pointerdown", unlockAudio, { once: false, passive: true });
  window.addEventListener("keydown", unlockAudio, { once: false });
}

export function playNotificationSound(): void {
  if (typeof window === "undefined") return;
  if (!loadNotificationSoundPref()) return;

  try {
    const ctx = getAudioContext();
    if (!ctx) return;
    if (ctx.state === "suspended") {
      ctx.resume().catch(() => {});
    }

    const start = ctx.currentTime + 0.01;
    const gain = ctx.createGain();
    const osc = ctx.createOscillator();

    osc.type = "sine";
    osc.frequency.setValueAtTime(659.25, start);
    osc.frequency.setValueAtTime(880, start + 0.11);

    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(0.075, start + 0.018);
    gain.gain.exponentialRampToValueAtTime(0.045, start + 0.12);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.30);

    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(start);
    osc.stop(start + 0.32);

    osc.onended = () => {
      try { osc.disconnect(); } catch {}
      try { gain.disconnect(); } catch {}
    };
  } catch {
    // Navegadores podem bloquear áudio sem interação do usuário. Falha silenciosa.
  }
}