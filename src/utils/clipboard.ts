// ============================================================================
// CÓPIA PARA A ÁREA DE TRANSFERÊNCIA — helper único.
//
// Mesmo mecanismo já usado pelos botões de copiar do app (CharTable/
// AvailableCharacter/modal "Ver"): tenta a Clipboard API e cai para o
// textarea oculto + execCommand quando ela não existe/é negada (mobile,
// contexto sem permissão, Electron file://). Retorna `true` quando a cópia
// foi efetivada — o chamador decide o feedback visual (sucesso/erro).
// ============================================================================

export async function copyTextToClipboard(text: string): Promise<boolean> {
  const value = String(text || "").trim();
  if (!value) return false;
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    // Fallback — mesmo mecanismo do copiar nome em AvailableCharacter.
    try {
      const area = document.createElement("textarea");
      area.value = value;
      area.style.position = "fixed";
      area.style.opacity = "0";
      area.style.pointerEvents = "none";
      document.body.appendChild(area);
      area.focus();
      area.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(area);
      return ok;
    } catch {
      return false;
    }
  }
}
