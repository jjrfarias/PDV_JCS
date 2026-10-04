// Envio de e-mail transacional. Somente o endereço do usuário e o link saem para o provedor.
const RESEND_URL = 'https://api.resend.com/emails';

export function createMailer(env = process.env) {
  if (env.RESEND_API_KEY && env.EMAIL_FROM) {
    return {
      configured: true,
      async sendPasswordReset({ to, link }) {
        const response = await fetch(RESEND_URL, {
          method: 'POST',
          signal: AbortSignal.timeout(10_000),
          headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from: env.EMAIL_FROM,
            to: [to],
            subject: 'PDV JCS - recuperação de senha',
            text: `Recebemos um pedido para redefinir sua senha do PDV JCS.\n\nAbra o link abaixo em até 30 minutos. Ele só pode ser usado uma vez:\n${link}\n\nSe você não fez este pedido, ignore este e-mail. Sua senha atual continua válida.`
          })
        });
        if (!response.ok) throw new Error(`MAIL_PROVIDER_${response.status}`);
      }
    };
  }
  if (env.NODE_ENV !== 'production') {
    // Laboratório local: sem provedor, o link aparece só no terminal do servidor, como as senhas iniciais.
    return {
      configured: false,
      async sendPasswordReset({ to, link }) { console.log(`\n[LOCAL] Recuperação de senha para ${to}:\n${link}\n`); }
    };
  }
  return {
    configured: false,
    async sendPasswordReset() { console.warn('Recuperação de senha solicitada, mas RESEND_API_KEY/EMAIL_FROM não estão configurados.'); }
  };
}
