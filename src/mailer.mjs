// Envio de e-mail transacional. Somente o endereço do destinatário e o link saem para o provedor.
const RESEND_URL = 'https://api.resend.com/emails';

const messages = {
  sendPasswordReset: ({ link }) => ({
    subject: 'PDV JCS - recuperação de senha',
    text: `Recebemos um pedido para redefinir sua senha do PDV JCS.\n\nAbra o link abaixo em até 30 minutos. Ele só pode ser usado uma vez:\n${link}\n\nSe você não fez este pedido, ignore este e-mail. Sua senha atual continua válida.`
  }),
  sendPasswordChanged: () => ({
    subject: 'PDV JCS - sua senha foi alterada',
    text: 'A senha da sua conta no PDV JCS acabou de ser alterada e as outras sessões foram encerradas.\n\nSe foi você, nada mais é necessário.\n\nSe não foi você, avise imediatamente o gerente da sua loja ou o suporte da Jordão Consultoria e Soluções. Use "Esqueci minha senha" na tela de acesso para retomar a conta.'
  }),
  sendInvite: ({ link, tenantName, tenantSlug }) => ({
    subject: 'PDV JCS - seu acesso de gerente',
    text: `Você foi cadastrado como gerente de ${tenantName} no PDV JCS.\n\nCrie sua senha pelo link abaixo em até 24 horas. Ele só pode ser usado uma vez:\n${link}\n\nPara entrar depois, use a empresa "${tenantSlug}" e este e-mail.\n\nSe você não esperava este convite, ignore este e-mail.`
  })
};

function mailer(deliver) {
  return Object.fromEntries(Object.entries(messages).map(([kind, build]) => [kind, message => deliver(message.to, build(message), kind, message.link)]));
}

export function createMailer(env = process.env) {
  if (env.RESEND_API_KEY && env.EMAIL_FROM) {
    return {
      configured: true,
      ...mailer(async (to, { subject, text }) => {
        const response = await fetch(RESEND_URL, {
          method: 'POST',
          signal: AbortSignal.timeout(10_000),
          headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ from: env.EMAIL_FROM, to: [to], subject, text })
        });
        if (!response.ok) throw new Error(`MAIL_PROVIDER_${response.status}`);
      })
    };
  }
  if (env.NODE_ENV !== 'production') {
    // Laboratório local: sem provedor, o link aparece só no terminal do servidor, como as senhas iniciais.
    return { configured: false, ...mailer(async (to, { subject }, kind, link) => { console.log(`\n[LOCAL] ${subject} para ${to}:\n${link}\n`); }) };
  }
  return { configured: false, ...mailer(async () => { console.warn('E-mail solicitado, mas RESEND_API_KEY/EMAIL_FROM não estão configurados.'); }) };
}
