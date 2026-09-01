import { initializeApp, getApps, getApp, type FirebaseApp } from "firebase/app";
import { connectAuthEmulator, getAuth } from "firebase/auth";
import { connectFirestoreEmulator, getFirestore } from "firebase/firestore";

/**
 * O modo Emulator só existe no Vite de desenvolvimento e exige opt-in explícito
 * no processo que inicia o Electron. Assim, uma build de produção nunca troca
 * silenciosamente o Firebase real por endpoints locais.
 */
const emulatorRequested = import.meta.env.VITE_USE_FIREBASE_EMULATORS === "true";
const useFirebaseEmulators = import.meta.env.DEV && emulatorRequested;
const emulatorProjectId = String(import.meta.env.VITE_FIREBASE_EMULATOR_PROJECT_ID || "demo-chernobyl-pt").trim() || "demo-chernobyl-pt";
const emulatorHost = String(import.meta.env.VITE_FIREBASE_EMULATOR_HOST || "127.0.0.1")
  .trim()
  .replace(/^https?:\/\//, "")
  .replace(/\/.*$/, "") || "127.0.0.1";

// Check if Vite environment variables are present and not placeholder values.
// No modo Emulator, somente o projectId muda para o projeto demo isolado;
// Auth e Firestore são conectados explicitamente abaixo antes de qualquer uso.
const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY || "",
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN || "",
  projectId: useFirebaseEmulators ? emulatorProjectId : (import.meta.env.VITE_FIREBASE_PROJECT_ID || ""),
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET || "",
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID || "",
  appId: import.meta.env.VITE_FIREBASE_APP_ID || "",
};

const hasValidConfig =
  firebaseConfig.apiKey
  && firebaseConfig.apiKey !== "YOUR_API_KEY"
  && firebaseConfig.projectId;

interface EmulatorConnectionGlobal {
  __chernobylFirebaseEmulatorsConnected__?: boolean;
}

const emulatorConnectionGlobal = globalThis as typeof globalThis & EmulatorConnectionGlobal;

let app: FirebaseApp | undefined;
let auth: any = null;
let db: any = null;
let isSimulationMode = true;

if (emulatorRequested && !import.meta.env.DEV) {
  console.warn("Firebase Emulator mode was ignored outside Vite development mode.");
}

if (hasValidConfig) {
  try {
    app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApp();
    auth = getAuth(app);
    db = getFirestore(app);

    if (useFirebaseEmulators && !emulatorConnectionGlobal.__chernobylFirebaseEmulatorsConnected__) {
      connectAuthEmulator(auth, `http://${emulatorHost}:9099`, { disableWarnings: true });
      connectFirestoreEmulator(db, emulatorHost, 8080);
      emulatorConnectionGlobal.__chernobylFirebaseEmulatorsConnected__ = true;
    }

    isSimulationMode = false;
    console.log(
      useFirebaseEmulators
        ? `Firebase initialized in Emulator Mode (${emulatorProjectId} at ${emulatorHost}).`
        : "Firebase initialized successfully in production mode.",
    );
  } catch (error) {
    console.error("Firebase initialization failed, falling back to Simulation Mode:", error);
    isSimulationMode = true;
  }
} else {
  console.log("No valid Firebase config detected. Running in Simulation Mode (Offline Sandbox).");
}

export { auth, db, isSimulationMode };
export {
  onSnapshot,
  setDoc,
  updateDoc,
  addDoc,
  deleteDoc,
  getDoc,
  getDocs,
} from "../utils/firestoreLogger";
export default app;