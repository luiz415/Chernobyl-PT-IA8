import { useState, useEffect } from "react";
import { useAuth } from "../context/AuthContext";
import authBgUrl from "../assets/auth-bg.png";
import ExoriLogo from "./ExoriLogo";
import { Shield, Lock, Mail, User, AlertCircle, RefreshCw, KeyRound, CheckCircle2, Phone, Swords, LogIn, MessageCircle, Monitor } from "lucide-react";

export default function AuthModal() {
  const {
    signUp,
    requestPendingLocally,
    userProfile,
    loading: authLoading,
    isSimulation,
    signOut,
    checkActiveSession,
    disconnectOtherSessions
  } = useAuth();

  const [activeTab, setActiveTab] = useState<"login" | "signup">("login");
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Estado de conflito de sessão
  const [sessionConflict, setSessionConflict] = useState(false);
  const [sessionTakeoverLoading, setSessionTakeoverLoading] = useState(false);
  const [sessionTakeoverSuccess, setSessionTakeoverSuccess] = useState(false);

  // Sign In inputs
  const [loginEmail, setLoginEmail] = useState(() => localStorage.getItem("tibia_auth_email") || "");
  const [loginPass, setLoginPass] = useState(() => localStorage.getItem("tibia_auth_pass") || "");
  const [rememberMe, setRememberMe] = useState(() => localStorage.getItem("tibia_auth_remember") === "true");
  const [autoLogin, setAutoLogin] = useState(() => localStorage.getItem("tibia_auto_login") === "true");

  // Sign Up inputs
  const [signupName, setSignupName] = useState("");
  const [signupEmail, setSignupEmail] = useState("");
  const [signupRepeatEmail, setSignupRepeatEmail] = useState("");
  const [signupPass, setSignupPass] = useState("");
  const [signupRepeatPass, setSignupRepeatPass] = useState("");

  // Novos campos para criação de conta
  const [mainCharacterName, setMainCharacterName] = useState("");
  const [whatsappCountry, setWhatsappCountry] = useState("55");
  const [whatsappRegion, setWhatsappRegion] = useState("");
  const [whatsappNumber, setWhatsappNumber] = useState("");

  // Login failure cooldown state
  const [cooldownTime, setCooldownTime] = useState(0);

  // O modal usa limite de viewport e rolagem interna pela base global de
  // modais. Não escalamos o conteúdo: transformações reduzem legibilidade e
  // podem deixar campos/cantos inacessíveis em zoom alto.

  // Handle countdown for login cooldown
  useEffect(() => {
    if (cooldownTime <= 0) return;
    const interval = setInterval(() => {
      setCooldownTime(prev => prev - 1);
    }, 1000);
    return () => clearInterval(interval);
  }, [cooldownTime]);

  // Auto-login: se "Salvar minhas informações" E "Login automático" estiverem marcados,
  // abre a AuthModal normalmente, aguarda 1 segundo e clica automaticamente em "Entrar".
  useEffect(() => {
    if (authLoading) return;
    if (isUserPending || isUserRefused) return;
    if (activeTab !== "login") return;

    const autoLoginEnabled = localStorage.getItem("tibia_auto_login") === "true";
    const rememberMeEnabled = localStorage.getItem("tibia_auth_remember") === "true";

    // Verifica se o auto-login já foi executado nesta sessão (evita loop ao deslogar)
    const alreadyExecuted = sessionStorage.getItem("tibia_auto_login_executed") === "true";

    if (!autoLoginEnabled || !rememberMeEnabled || alreadyExecuted) return;

    const savedEmail = localStorage.getItem("tibia_auth_email") || "";
    const savedPass = localStorage.getItem("tibia_auth_pass") || "";
    if (!savedEmail.trim() || !savedPass.trim()) return;

    const timer = setTimeout(async () => {
      sessionStorage.setItem("tibia_auto_login_executed", "true");
      setLoading(true);
      setErrorMessage(null);
      try {
        const result = await checkActiveSession(savedEmail, savedPass);
        if (result === "occupied") {
          setSessionConflict(true);
          setLoading(false);
          return;
        }
        // "free": login completado — credenciais já estão salvas
      } catch (err: any) {
        setErrorMessage(err?.message || "Falha no login automático. Faça login manualmente.");
        setCooldownTime(10);
      } finally {
        setLoading(false);
      }
    }, 1000);

    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authLoading]);

  // If user is pending approval
  const isUserPending = userProfile?.status === "pendente" || requestPendingLocally;
  const isUserRefused = userProfile?.status === "recusado";

  // Name input validation: letters only, no numbers, no spaces
  function handleNameChange(val: string) {
    const lettersOnly = val.replace(/[^A-Za-zÀ-ÿ]/g, "").slice(0, 10);
    setSignupName(lettersOnly);
  }

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    if (cooldownTime > 0) return;
    if (!loginEmail.trim() || !loginPass.trim()) {
      setErrorMessage("Por favor, preencha todos os campos.");
      return;
    }

    setLoading(true);
    setErrorMessage(null);

    try {
      const result = await checkActiveSession(loginEmail, loginPass);
      if (result === "occupied") {
        // Sessão ativa detectada — exibir tela de conflito
        setSessionConflict(true);
        setLoading(false);
        return;
      }
      // "free": login completado com sucesso dentro do checkActiveSession
      // Salvar credenciais se rememberMe
      if (rememberMe) {
        localStorage.setItem("tibia_auth_remember", "true");
        localStorage.setItem("tibia_auth_email", loginEmail);
        localStorage.setItem("tibia_auth_pass", loginPass);
      }
      if (localStorage.getItem("tibia_auto_login") === "true") {
        localStorage.setItem("tibia_saved_email", btoa(loginEmail));
        localStorage.setItem("tibia_saved_pass", btoa(loginPass));
      }
    } catch (err: any) {
      setErrorMessage(err?.message || "E-mail ou senha inválidos.");
      setCooldownTime(10);
    } finally {
      setLoading(false);
    }
  }

  async function handleForceDisconnect() {
    setSessionTakeoverLoading(true);
    setErrorMessage(null);
    try {
      await disconnectOtherSessions();
      setSessionTakeoverSuccess(true);
      setTimeout(() => {
        setSessionTakeoverSuccess(false);
        setSessionConflict(false);
        setSessionTakeoverLoading(false);
      }, 1000);
    } catch (err: any) {
      setErrorMessage(err?.message || "Erro ao desconectar outros dispositivos.");
      setSessionTakeoverLoading(false);
    }
  }

  function handleCancelSessionConflict() {
    setSessionConflict(false);
    setErrorMessage(null);
  }

  async function handleSignUp(e: React.FormEvent) {
    e.preventDefault();
    if (isUserPending) return;

    if (!signupName.trim() || !signupEmail.trim() || !signupRepeatEmail.trim() || !signupPass.trim() || !signupRepeatPass.trim()) {
      setErrorMessage("Por favor, preencha todos os campos obrigatórios.");
      return;
    }

    if (!mainCharacterName.trim()) {
      setErrorMessage("Preencha o nome do personagem principal.");
      return;
    }

    if (!whatsappCountry.trim() || !whatsappRegion.trim() || !whatsappNumber.trim()) {
      setErrorMessage("O campo WhatsApp é obrigatório. Preencha o código do país, DDD e número.");
      return;
    }

    if (signupEmail.toLowerCase().trim() !== signupRepeatEmail.toLowerCase().trim()) {
      setErrorMessage("Os campos de e-mail informados não são idênticos.");
      return;
    }

    if (signupPass !== signupRepeatPass) {
      setErrorMessage("A confirmação da senha não coincide.");
      return;
    }

    setLoading(true);
    setErrorMessage(null);

    try {
      await signUp(signupName, signupEmail, signupPass, {
        mainCharacterName: mainCharacterName.trim(),
        whatsappCountry: whatsappCountry.trim(),
        whatsappRegion: whatsappRegion.trim(),
        whatsappNumber: whatsappNumber.trim(),
      });
    } catch (err: any) {
      setErrorMessage(err?.message || "Ocorreu um erro ao criar a sua conta.");
    } finally {
      setLoading(false);
    }
  }

  if (authLoading) {
    return (
      <div className="fixed inset-0 z-[9999] bg-[var(--th-bg-abyss)] flex flex-col items-center justify-center gap-4">
        <ExoriLogo size={80} className="drop-shadow-[0_0_20px_color-mix(in_oklab,var(--th-brand)_80%,transparent)]" />
        <div className="flex items-center gap-2 text-slate-500 text-sm">
          <RefreshCw size={16} className="animate-spin text-red-600" />
          <span>Verificando autenticação...</span>
        </div>
      </div>
    );
  }

  return (
    <div className="app-modal-overlay fixed inset-0 z-[9998] bg-[var(--th-bg-abyss)] flex items-center justify-center">
      {/* CAMADA 1 (mais ao fundo): Imagem de fundo — absolute para respeitar o stacking context do pai */}
      <div
        className="absolute inset-0 pointer-events-none bg-[var(--th-bg-abyss)] animate-in fade-in duration-700"
        style={{
          backgroundImage: `url(${authBgUrl})`,
          backgroundSize: '120%',
          backgroundPosition: '50% 50%',
          backgroundRepeat: 'no-repeat',
          zIndex: 0,
        }}
      />
      {/* CAMADA 2 (meio): Filtro escuro sobre a imagem (sem blur) */}
      <div className="absolute inset-0 bg-[var(--th-bg-abyss)]/80 pointer-events-none" style={{ zIndex: 1 }} />
      {/* CAMADA 2.5: Background glowing blobs (ainda atrás do card) */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none" style={{ zIndex: 2 }}>
        <div className="absolute -top-[10%] -left-[10%] w-[50%] h-[50%] rounded-full bg-[var(--th-brand)]/8 blur-[120px]" />
        <div className="absolute -bottom-[10%] -right-[10%] w-[50%] h-[50%] rounded-full bg-[var(--th-line)]/10 blur-[120px]" />
      </div>

      <div
        className="app-modal-frame app-modal-size-sm app-modal-frame--scroll relative w-full max-w-md bg-[var(--th-n-base)] border border-[var(--th-brand)]/100 rounded-2xl shadow-[0_0_60px_color-mix(in_oklab,var(--th-brand)_35%,transparent),0_0_120px_color-mix(in_oklab,var(--th-brand)_10%,transparent)] z-10"
      >

        {/* Banner header mode check */}
        {isSimulation && (
          <div className="bg-amber-500/8 border-b border-amber-600/25 px-4 py-2 text-center text-[10px] text-amber-400 font-bold tracking-wider flex items-center justify-center gap-1.5 uppercase flex-shrink-0">
            <Shield size={12} /> Modo de Testes (Simulado Local)
          </div>
        )}

        {/* Scrollable content */}
        <div className="app-modal-body">

        {/* Logo/Identity */}
        <div className="flex flex-col items-center pt-8 pb-4 text-center">
          <div className="w-14 h-14 flex items-center justify-center mb-3">
            <ExoriLogo size={56} className="drop-shadow-[0_0_12px_color-mix(in_oklab,var(--th-brand)_70%,transparent)]" />
          </div>
          <h2 className="text-2xl font-black bg-gradient-to-r from-red-600 via-orange-500 to-yellow-400 bg-clip-text text-transparent tracking-tight">
            Chernobyl PT
          </h2>
          <p className="text-amber-400/70 leading-none tracking-wide truncate" style={{ fontSize: "clamp(5px, 0.9vh, 9px)" }}>By Exori Coins</p>
        </div>

        {/* Session conflict: another device is active */}
        {sessionConflict ? (
          sessionTakeoverSuccess ? (
            <div className="p-6 text-center space-y-4 animate-in fade-in zoom-in duration-200">
              <div className="w-16 h-16 rounded-2xl bg-emerald-500/10 border border-emerald-500/40 flex items-center justify-center mx-auto shadow-[0_0_20px_rgba(16,185,129,0.15)]">
                <CheckCircle2 size={32} className="text-emerald-400" />
              </div>
              <div className="space-y-2">
                <h3 className="text-base font-bold text-white tracking-wide">
                  Todos os outros dispositivos foram desconectados com sucesso.
                </h3>
              </div>
            </div>
          ) : (
            <div className="p-6 text-center space-y-5 animate-in fade-in zoom-in duration-300">
              <div className="w-16 h-16 rounded-2xl bg-amber-500/8 border border-amber-600/30 flex items-center justify-center mx-auto shadow-[0_0_20px_color-mix(in_oklab,var(--color-amber-500)_10%,transparent)]">
                <Monitor size={28} className="text-amber-400" />
              </div>
              <div className="space-y-2">
                <h3 className="text-base font-bold text-white tracking-wide">Sua conta já está conectada em outro dispositivo.</h3>
                <p className="text-xs text-slate-500 leading-relaxed px-4">
                  Uma sessão ativa foi detectada. Você pode desconectar o outro dispositivo e continuar aqui, ou cancelar esta tentativa de login.
                </p>
              </div>
              {errorMessage && (
                <div className="p-3 bg-rose-500/8 border border-rose-500/25 text-rose-400 text-xs rounded-xl flex items-start gap-2.5">
                  <AlertCircle size={15} className="flex-shrink-0 mt-0.5" />
                  <p className="leading-relaxed">{errorMessage}</p>
                </div>
              )}
              <div className="flex gap-3">
                <button
                  onClick={handleCancelSessionConflict}
                  disabled={sessionTakeoverLoading}
                  className="flex-1 py-2.5 rounded-lg border border-[var(--th-line)]/100 hover:bg-[var(--th-line)]/20 text-slate-400 hover:text-white text-xs font-bold transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  Cancelar
                </button>
                <button
                  onClick={handleForceDisconnect}
                  disabled={sessionTakeoverLoading}
                  className="flex-1 py-2.5 rounded-lg bg-gradient-to-r from-[var(--th-brand-mid)] to-[var(--th-brand)] hover:from-[var(--th-brand-bright)] hover:to-[var(--th-brand-deep)] text-white text-xs font-bold shadow-lg shadow-red-900/20 transition-all cursor-pointer border border-[var(--th-brand-mid)]/50 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-1.5"
                >
                  {sessionTakeoverLoading ? (
                    <><RefreshCw size={13} className="animate-spin" /> Desconectando...</>
                  ) : (
                    "Desconectar outros dispositivos"
                  )}
                </button>
              </div>
            </div>
          )
        ) : isUserPending ? (
          <div className="p-6 text-center space-y-5 animate-in fade-in zoom-in duration-300">
            <div className="w-16 h-16 rounded-2xl bg-amber-500/8 border border-amber-600/30 flex items-center justify-center mx-auto shadow-[0_0_20px_color-mix(in_oklab,var(--color-amber-500)_10%,transparent)]">
              <RefreshCw size={28} className="text-amber-400 animate-spin" />
            </div>
            <div className="space-y-2">
              <h3 className="text-base font-bold text-white tracking-wide">Solicitação Pendente</h3>
              <p className="text-xs text-slate-500 leading-relaxed px-4">
                Sua conta foi criada. Por favor, aguarde a aprovação de um Administrador.
              </p>
              {isSimulation && (
                <div className="mt-3 p-3 bg-violet-950/20 border border-violet-500/20 rounded-lg text-left space-y-1">
                  <span className="text-[10px] text-violet-400 font-black block uppercase">Dica de Desenvolvimento:</span>
                  <p className="text-[10px] text-slate-500 leading-relaxed">
                    O primeiro usuário criado na simulação é aprovado e torna-se <strong className="text-violet-300">Boss</strong> automaticamente. Para aprovar este usuário secundário, faça login na conta de Boss (a primeira conta criada) e aprove-o através do botão de Administração no rodapé.
                  </p>
                </div>
              )}
            </div>
            <button
              onClick={signOut}
              className="w-full py-2.5 rounded-lg border border-[var(--th-line)]/100 hover:bg-[var(--th-line)]/20 text-slate-400 hover:text-white text-xs font-bold transition-colors cursor-pointer"
            >
              Voltar para o Login
            </button>
          </div>
        ) : isUserRefused ? (
          <div className="p-6 text-center space-y-5 animate-in fade-in zoom-in duration-300">
            <div className="w-16 h-16 rounded-2xl bg-rose-500/8 border border-rose-500/25 flex items-center justify-center mx-auto shadow-[0_0_20px_color-mix(in_oklab,var(--color-red-600)_10%,transparent)]">
              <AlertCircle size={28} className="text-rose-400" />
            </div>
            <div className="space-y-2">
              <h3 className="text-base font-bold text-white tracking-wide">Solicitação Recusada</h3>
              <p className="text-xs text-slate-500 leading-relaxed px-4">
                Desculpe, seu cadastro foi recusado ou bloqueado. Qualquer dúvida, entre em contato com um administrador.
              </p>
            </div>
            <button
              onClick={signOut}
              className="w-full py-2.5 rounded-lg border border-[var(--th-line)]/100 hover:bg-[var(--th-line)]/20 text-slate-400 hover:text-white text-xs font-bold transition-colors cursor-pointer"
            >
              Voltar para o Login
            </button>
          </div>
        ) : (
          <>
            {/* Nav tabs */}
            <div className="flex bg-[var(--th-n-deep)] border-y border-[var(--th-line)]/60 p-1">
              <button
                type="button"
                onClick={() => { setActiveTab("login"); setErrorMessage(null); }}
                className={`flex-1 py-2 text-xs font-bold rounded-lg transition-all flex items-center justify-center gap-1.5 cursor-pointer ${
                  activeTab === "login"
                    ? "bg-gradient-to-r from-[var(--th-bg-raised)] to-[var(--th-bg-base)] border border-[var(--th-line)]/100 text-white shadow-[0_0_10px_color-mix(in_oklab,var(--th-brand)_12%,transparent)]"
                    : "text-slate-600 hover:bg-[var(--th-line)]/15 hover:text-slate-400"
                }`}
              >
                <Lock size={13} />
                <span>Entrar</span>
              </button>
              <button
                type="button"
                onClick={() => { setActiveTab("signup"); setErrorMessage(null); }}
                className={`flex-1 py-2 text-xs font-bold rounded-lg transition-all flex items-center justify-center gap-1.5 cursor-pointer ${
                  activeTab === "signup"
                    ? "bg-gradient-to-r from-[var(--th-bg-raised)] to-[var(--th-bg-base)] border border-[var(--th-line)]/100 text-white shadow-[0_0_10px_color-mix(in_oklab,var(--th-brand)_12%,transparent)]"
                    : "text-slate-600 hover:bg-[var(--th-line)]/15 hover:text-slate-400"
                }`}
              >
                <User size={13} />
                <span>Criar Conta</span>
              </button>
            </div>

            {/* Error Message */}
            {errorMessage && (
              <div className="mx-5 mt-4 p-3 bg-rose-500/8 border border-rose-500/25 text-rose-400 text-xs rounded-xl flex items-start gap-2.5 animate-in slide-in-from-top-2 duration-200">
                <AlertCircle size={15} className="flex-shrink-0 mt-0.5" />
                <p className="leading-relaxed">{errorMessage}</p>
              </div>
            )}

            {/* Forms */}
            <div className="p-5">
              {activeTab === "login" ? (
                /* LOGIN FORM */
                <form onSubmit={handleLogin} className="space-y-4">
                  <div>
                    <label className="block text-[10px] text-red-400/70 uppercase tracking-widest font-black mb-1.5">E-mail</label>
                    <div className="relative">
                      <Mail size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-600" />
                      <input
                        type="text"
                        value={loginEmail}
                        onChange={e => setLoginEmail(e.target.value)}
                        placeholder="seuemail@chernobylteam.com"
                        className="w-full bg-black/40 border border-[var(--th-line)]/100 focus:border-red-700/60 rounded-lg pl-9 pr-3 py-2 text-sm text-white focus:outline-none placeholder-slate-650 transition-colors"
                      />
                    </div>
                  </div>

                  <div>
                    <label className="block text-[10px] text-red-400/70 uppercase tracking-widest font-black mb-1.5">Senha</label>
                    <div className="relative">
                      <KeyRound size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-600" />
                      <input
                        type="password"
                        value={loginPass}
                        onChange={e => setLoginPass(e.target.value)}
                        placeholder="••••••••"
                        className="w-full bg-black/40 border border-[var(--th-line)]/100 focus:border-red-700/60 rounded-lg pl-9 pr-3 py-2 text-sm text-white focus:outline-none placeholder-slate-650 transition-colors"
                      />
                    </div>
                  </div>

                  <div className="flex items-center justify-between">
                    <label className="group flex items-center gap-2.5 text-xs select-none cursor-pointer py-1 transition-colors">
                      <input
                        type="checkbox"
                        checked={rememberMe}
                        onChange={e => setRememberMe(e.target.checked)}
                        className="sr-only peer"
                      />
                      <div className={`relative w-[18px] h-[18px] rounded-[5px] border-2 flex-shrink-0 flex items-center justify-center transition-all duration-200 ${
                        rememberMe
                          ? "bg-gradient-to-br from-[var(--th-brand-mid)] to-[var(--th-brand-deep)] border-amber-600/50 shadow-[0_0_8px_color-mix(in_oklab,var(--th-brand)_40%,transparent),inset_0_1px_1px_rgba(255,255,255,0.08)]"
                          : "bg-[var(--th-n-deep)] border-[var(--th-line)]/100 group-hover:border-[var(--th-brand)]/100 group-hover:bg-[var(--th-bg-base)]"
                      }`}>
                        {rememberMe && (
                          <svg width="10" height="8" viewBox="0 0 10 8" fill="none" className="drop-shadow-sm">
                            <path d="M1.5 4L3.8 6.5L8.5 1.5" stroke="#f6c96e" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                          </svg>
                        )}
                      </div>
                      <Lock size={12} className={`transition-colors duration-200 ${rememberMe ? "text-amber-400/90" : "text-amber-500/40 group-hover:text-amber-500/60"}`} />
                      <span className={`transition-colors duration-200 ${rememberMe ? "text-slate-300" : "text-slate-500 group-hover:text-slate-400"}`}>Salvar minhas informações</span>
                    </label>
                  </div>

                  <div className="flex items-center">
                    <label className="group flex items-center gap-2.5 text-xs select-none cursor-pointer py-1 transition-colors">
                      <input
                        type="checkbox"
                        checked={autoLogin}
                        onChange={e => {
                          setAutoLogin(e.target.checked);
                          if (e.target.checked) {
                            localStorage.setItem("tibia_auto_login", "true");
                          } else {
                            localStorage.removeItem("tibia_auto_login");
                            localStorage.removeItem("tibia_saved_email");
                            localStorage.removeItem("tibia_saved_pass");
                          }
                        }}
                        className="sr-only peer"
                      />
                      <div className={`relative w-[18px] h-[18px] rounded-[5px] border-2 flex-shrink-0 flex items-center justify-center transition-all duration-200 ${
                        autoLogin
                          ? "bg-gradient-to-br from-[var(--th-brand-mid)] to-[var(--th-brand-deep)] border-amber-600/50 shadow-[0_0_8px_color-mix(in_oklab,var(--th-brand)_40%,transparent),inset_0_1px_1px_rgba(255,255,255,0.08)]"
                          : "bg-[var(--th-n-deep)] border-[var(--th-line)]/100 group-hover:border-[var(--th-brand)]/100 group-hover:bg-[var(--th-bg-base)]"
                      }`}>
                        {autoLogin && (
                          <svg width="10" height="8" viewBox="0 0 10 8" fill="none" className="drop-shadow-sm">
                            <path d="M1.5 4L3.8 6.5L8.5 1.5" stroke="#f6c96e" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                          </svg>
                        )}
                      </div>
                      <LogIn size={12} className={`transition-colors duration-200 ${autoLogin ? "text-amber-400/90" : "text-amber-500/40 group-hover:text-amber-500/60"}`} />
                      <span className={`transition-colors duration-200 ${autoLogin ? "text-slate-300" : "text-slate-500 group-hover:text-slate-400"}`}>Login automático</span>
                    </label>
                  </div>

                  <button
                    type="submit"
                    disabled={loading || cooldownTime > 0}
                    className={`w-full py-3 rounded-xl text-sm font-bold text-white shadow-[0_4px_20px_color-mix(in_oklab,var(--th-brand)_30%,transparent)] bg-gradient-to-r from-[var(--th-brand-mid)] to-[var(--th-brand)] hover:from-[var(--th-brand-bright)] hover:to-[var(--th-brand-deep)] border border-[var(--th-brand-mid)]/50 transition-all duration-300 cursor-pointer flex items-center justify-center gap-2 hover:scale-[1.02] active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:scale-100 ${
                      cooldownTime > 0
                        ? "from-[var(--th-brand-mid)]/60 to-[var(--th-brand)]/60 opacity-60 cursor-not-allowed hover:scale-100"
                        : ""
                    }`}
                  >
                    {loading ? (
                      <>
                        <RefreshCw size={14} className="animate-spin" />
                        <span>Entrando...</span>
                      </>
                    ) : cooldownTime > 0 ? (
                      <span>Aguarde {cooldownTime}s</span>
                    ) : (
                      <span>Entrar</span>
                    )}
                  </button>

                  {/* Área de suporte via WhatsApp */}
                  <div className="rounded-lg border border-[var(--th-line)]/90 bg-[var(--th-line)]/[0.06] p-3 flex items-center justify-between gap-3">
                    <p className="text-[11px] text-slate-500 leading-relaxed">
                      Está enfrentando algum problema ou tem alguma dúvida? Entre em contato com o suporte através do WhatsApp
                    </p>
                    <a
                      href="https://wa.me/5535999349969"
                      target="_blank"
                      rel="noopener noreferrer"
                      title="Falar com o suporte no WhatsApp"
                      className="flex-shrink-0 inline-flex items-center justify-center w-9 h-9 rounded-lg border border-emerald-500/25 bg-emerald-500/8 text-emerald-400 hover:text-emerald-300 hover:bg-emerald-500/15 transition-colors cursor-pointer"
                    >
                      <MessageCircle size={18} />
                    </a>
                  </div>
                </form>
              ) : (
                /* SIGN UP FORM */
                <form onSubmit={handleSignUp} className="space-y-4">
                  <div>
                    <label className="block text-[10px] text-red-400/70 uppercase tracking-widest font-black mb-1.5">Primeiro Nome *</label>
                    <div className="relative">
                      <User size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-600" />
                      <input
                        type="text"
                        value={signupName}
                        onChange={e => handleNameChange(e.target.value)}
                        placeholder="Apenas letras, sem espaços ou números"
                        className="w-full bg-black/40 border border-[var(--th-line)]/100 focus:border-red-700/60 rounded-lg pl-9 pr-3 py-2 text-sm text-white focus:outline-none placeholder-slate-650 transition-colors"
                      />
                    </div>
                  </div>

                  {/* PRINCIPAL personagem (nome) */}
                  <div>
                    <label className="block text-[10px] text-red-400/70 uppercase tracking-widest font-black mb-1.5">PRINCIPAL personagem (nome) *</label>
                    <div className="relative">
                      <Swords size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-600" />
                      <input
                        type="text"
                        value={mainCharacterName}
                        onChange={e => setMainCharacterName(e.target.value.replace(/[^A-Za-zÀ-ÿ\s]/g, "").slice(0, 30))}
                        maxLength={30}
                        placeholder="Nome do personagem principal no RubinOT"
                        className="w-full bg-black/40 border border-[var(--th-line)]/100 focus:border-red-700/60 rounded-lg pl-9 pr-3 py-2 text-sm text-white focus:outline-none placeholder-slate-650 transition-colors"
                      />
                    </div>
                    <p className="text-[9px] text-slate-700 mt-1">Personagem que receberá pagamentos em RC.</p>
                  </div>

                  {/* WhatsApp */}
                  <div>
                    <label className="block text-[10px] text-red-400/70 uppercase tracking-widest font-black mb-1.5">
                      <span className="inline-flex items-center gap-1"><Phone size={10} className="text-amber-500/70" /> WhatsApp *</span>
                    </label>
                    <div className="grid grid-cols-[65px_70px_1fr] gap-2">
                      {/* Código do país */}
                      <div className="relative">
                        <span className="absolute left-2 top-1/2 -translate-y-1/2 text-slate-500 text-xs font-bold pointer-events-none">+</span>
                        <input
                          type="text"
                          value={whatsappCountry}
                          onChange={e => setWhatsappCountry(e.target.value.replace(/\D/g, "").slice(0, 3))}
                          maxLength={3}
                          className="w-full pl-5 pr-1 py-2 bg-black/40 border border-[var(--th-line)]/100 focus:border-red-700/60 rounded-lg text-white text-sm text-center focus:outline-none transition-colors"
                          placeholder="55"
                        />
                      </div>
                      {/* DDD / Região */}
                      <input
                        type="text"
                        value={whatsappRegion}
                        onChange={e => setWhatsappRegion(e.target.value.replace(/\D/g, "").slice(0, 5))}
                        maxLength={5}
                        className="w-full px-2 py-2 bg-black/40 border border-[var(--th-line)]/100 focus:border-red-700/60 rounded-lg text-white text-sm text-center focus:outline-none transition-colors"
                        placeholder="DDD"
                      />
                      {/* Número */}
                      <input
                        type="text"
                        value={whatsappNumber}
                        onChange={e => setWhatsappNumber(e.target.value.replace(/\D/g, "").slice(0, 10))}
                        maxLength={10}
                        className="w-full px-3 py-2 bg-black/40 border border-[var(--th-line)]/100 focus:border-red-700/60 rounded-lg text-white text-sm focus:outline-none transition-colors"
                        placeholder="Número"
                      />
                    </div>
                    <p className="text-[9px] text-slate-700 mt-1">Ex: +55 11 999999999</p>
                  </div>

                  <div>
                    <label className="block text-[10px] text-red-400/70 uppercase tracking-widest font-black mb-1.5">E-mail *</label>
                    <div className="relative">
                      <Mail size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-600" />
                      <input
                        type="text"
                        value={signupEmail}
                        onChange={e => setSignupEmail(e.target.value)}
                        placeholder="seuemail@chernobylteam.com"
                        className="w-full bg-black/40 border border-[var(--th-line)]/100 focus:border-red-700/60 rounded-lg pl-9 pr-3 py-2 text-sm text-white focus:outline-none placeholder-slate-650 transition-colors"
                      />
                    </div>
                  </div>

                  <div>
                    <label className="block text-[10px] text-red-400/70 uppercase tracking-widest font-black mb-1.5">Repetir E-mail *</label>
                    <div className="relative">
                      <Mail size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-600" />
                      <input
                        type="text"
                        value={signupRepeatEmail}
                        onChange={e => setSignupRepeatEmail(e.target.value)}
                        placeholder="Confirme o seu e-mail"
                        className="w-full bg-black/40 border border-[var(--th-line)]/100 focus:border-red-700/60 rounded-lg pl-9 pr-3 py-2 text-sm text-white focus:outline-none placeholder-slate-650 transition-colors"
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-[10px] text-red-400/70 uppercase tracking-widest font-black mb-1.5">Senha *</label>
                      <input
                        type="password"
                        value={signupPass}
                        onChange={e => setSignupPass(e.target.value)}
                        placeholder="••••••••"
                        className="w-full bg-black/40 border border-[var(--th-line)]/100 focus:border-red-700/60 rounded-lg px-3 py-2 text-sm text-white focus:outline-none placeholder-slate-650 transition-colors"
                      />
                    </div>
                    <div>
                      <label className="block text-[10px] text-red-400/70 uppercase tracking-widest font-black mb-1.5">Repetir Senha *</label>
                      <input
                        type="password"
                        value={signupRepeatPass}
                        onChange={e => setSignupRepeatPass(e.target.value)}
                        placeholder="••••••••"
                        className="w-full bg-black/40 border border-[var(--th-line)]/100 focus:border-red-700/60 rounded-lg px-3 py-2 text-sm text-white focus:outline-none placeholder-slate-650 transition-colors"
                      />
                    </div>
                  </div>

                  <button
                    type="submit"
                    disabled={loading || isUserPending}
                    className={`w-full py-2.5 rounded-lg text-sm font-bold shadow-lg transition-all flex items-center justify-center gap-2 cursor-pointer ${
                      isUserPending
                        ? "bg-amber-500/8 border border-amber-600/25 text-amber-400/80 cursor-not-allowed"
                        : "bg-gradient-to-r from-[var(--th-brand-mid)] to-[var(--th-brand)] hover:from-[var(--th-brand-bright)] hover:to-[var(--th-brand-deep)] text-white shadow-[0_4px_20px_color-mix(in_oklab,var(--th-brand)_25%,transparent)] border border-[var(--th-brand-mid)]/50 hover:scale-[1.01]"
                    }`}
                  >
                    {loading ? (
                      <>
                        <RefreshCw size={14} className="animate-spin" />
                        <span>Solicitando...</span>
                      </>
                    ) : isUserPending ? (
                      <>
                        <CheckCircle2 size={14} />
                        <span>Solicitação Pendente</span>
                      </>
                    ) : (
                      <span>Solicitar Entrada</span>
                    )}
                  </button>
                </form>
              )}
            </div>
          </>
        )}

        </div>{/* end scrollable content */}

        {/* Botão discreto de reset — visível apenas em modo simulação */}
        {isSimulation && (
          <div className="border-t border-[var(--th-line)]/30 bg-[var(--th-n-deep)] px-4 py-2 flex items-center justify-between flex-shrink-0">
            <span className="text-[9px] text-slate-700">Modo Sandbox: dados salvos localmente</span>
            <button
              type="button"
              onClick={() => {
                if (!window.confirm("Tem certeza que deseja resetar TODOS os dados de teste?\nIsso irá apagar todas as contas e notificações simuladas.")) return;
                const keys = [
                  "tibia_sim_users",
                  "tibia_sim_passwords",
                  "tibia_sim_notifications",
                  "tibia_sim_session_uid",
                  "tibia_auth_pending_locally",
                  "tibia_notif_seen_keys",
                  "tibia_notified_update_version"
                ];
                keys.forEach(k => localStorage.removeItem(k));
                window.location.reload();
              }}
              className="text-[9px] px-2 py-1 rounded border border-rose-500/20 bg-rose-500/5 text-rose-400 hover:bg-rose-500/15 hover:text-rose-300 hover:border-rose-500/40 transition-colors cursor-pointer uppercase tracking-wider font-bold"
            >
              🗑 Resetar Contas (Teste)
            </button>
          </div>
        )}
      </div>
    </div>
  );
}