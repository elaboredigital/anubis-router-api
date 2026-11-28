// Envio de e-mail transacional (confirmação de cadastro e link de acesso) por SMTP.
// Sem SMTP_HOST, nada é enviado: o link aparece apenas no log do processo (uso local e testes).
const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function smtpConfig(env = process.env) {
  if (!env.SMTP_HOST) return null;
  const port = Number(env.SMTP_PORT || 587);
  return {
    host: env.SMTP_HOST, port,
    secure: env.SMTP_SECURE ? env.SMTP_SECURE === 'true' : port === 465,
    auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS || '' } : undefined,
    from: env.MAIL_FROM || 'Anubis Router <no-reply@anubisrouter.com>',
  };
}

export function buildEmail(kind, { link }) {

  const copy = {
    verify: {
      subject: 'Confirme seu cadastro no Anubis Router',
      intro: `Olá! Falta um passo para ativar sua conta: confirme este e-mail.`,
      action: 'Confirmar e-mail', note: 'O link vale por 48 horas. Se você não criou esta conta, ignore este e-mail.',
    },
    magic: {
      subject: 'Seu link de acesso ao Anubis Router',
      intro: `Olá! Use o botão abaixo para entrar na sua conta.`,
      action: 'Entrar na conta', note: 'O link vale por 15 minutos e funciona uma única vez. Se você não pediu, ignore este e-mail.',
    },
  }[kind];
  const text = `${copy.intro.replace(/&[a-z#0-9]+;/g, m => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" })[m] || m)}\n\n${copy.action}: ${link}\n\n${copy.note}\n`;
  const html = `<!doctype html><html lang="pt-BR"><body style="margin:0;background:#fbfaf7;font-family:Segoe UI,Arial,sans-serif;color:#121212">
<div style="max-width:520px;margin:0 auto;padding:32px 24px"><p style="font-size:18px;font-weight:700;margin:0 0 20px"><img src="${escape(new URL('/brand.png', link).href)}" width="32" height="32" alt="" style="vertical-align:middle;margin-right:10px;border:0;border-radius:6px"><span style="vertical-align:middle">Anubis Router</span></p>
<p style="font-size:15px;line-height:1.55;margin:0 0 24px">${copy.intro}</p>
<p style="margin:0 0 24px"><a href="${escape(link)}" style="display:inline-block;background:#121212;color:#fff;text-decoration:none;font-weight:600;padding:12px 22px;border-radius:999px">${copy.action}</a></p>
<p style="font-size:13px;line-height:1.5;color:#6b6759;margin:0 0 8px">Se o botão não abrir, copie este endereço no navegador:<br><span style="word-break:break-all">${escape(link)}</span></p>
<p style="font-size:13px;line-height:1.5;color:#6b6759;margin:0">${copy.note}</p></div></body></html>`;
  return { subject: copy.subject, text, html };
}

export async function createMailer(env = process.env) {
  const config = smtpConfig(env);
  if (!config) {
    return { configured: false, async send(to, kind, data) { console.log(`[e-mail não enviado: SMTP_HOST ausente] ${kind} para ${to}: ${data.link}`); return { sent: false }; } };
  }
  const { default: nodemailer } = await import('nodemailer');
  const transport = nodemailer.createTransport({ host: config.host, port: config.port, secure: config.secure, auth: config.auth });
  return {
    configured: true,
    async send(to, kind, data) {
      const message = buildEmail(kind, data);
      await transport.sendMail({ from: config.from, to, ...message });
      return { sent: true };
    },
  };
}
