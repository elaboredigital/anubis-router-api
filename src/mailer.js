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

// E-mails de conta no idioma da pessoa (o mesmo escolhido no site). Sem idioma conhecido, vai em inglês.
export const MAIL_LANGS = ['en', 'pt-br', 'es', 'he', 'ru', 'it'];
const COPY = {
  en: {
    html: 'en', dir: 'ltr', fallback: "If the button doesn't open, copy this address into your browser:",
    verify: { subject: 'Confirm your Anubis Router account', intro: 'Hi! One last step to activate your account: confirm this email.', action: 'Confirm email', note: "The link is valid for 48 hours. If you didn't create this account, ignore this email." },
    magic: { subject: 'Your Anubis Router sign-in link', intro: 'Hi! Use the button below to sign in to your account.', action: 'Sign in', note: "The link is valid for 15 minutes and works only once. If you didn't request it, ignore this email." },
  },
  'pt-br': {
    html: 'pt-BR', dir: 'ltr', fallback: 'Se o botão não abrir, copie este endereço no navegador:',
    verify: { subject: 'Confirme seu cadastro no Anubis Router', intro: 'Olá! Falta um passo para ativar sua conta: confirme este e-mail.', action: 'Confirmar e-mail', note: 'O link vale por 48 horas. Se você não criou esta conta, ignore este e-mail.' },
    magic: { subject: 'Seu link de acesso ao Anubis Router', intro: 'Olá! Use o botão abaixo para entrar na sua conta.', action: 'Entrar na conta', note: 'O link vale por 15 minutos e funciona uma única vez. Se você não pediu, ignore este e-mail.' },
  },
  es: {
    html: 'es', dir: 'ltr', fallback: 'Si el botón no se abre, copia esta dirección en el navegador:',
    verify: { subject: 'Confirma tu cuenta de Anubis Router', intro: '¡Hola! Falta un paso para activar tu cuenta: confirma este correo.', action: 'Confirmar correo', note: 'El enlace vale por 48 horas. Si no creaste esta cuenta, ignora este correo.' },
    magic: { subject: 'Tu enlace de acceso a Anubis Router', intro: '¡Hola! Usa el botón de abajo para entrar en tu cuenta.', action: 'Entrar en la cuenta', note: 'El enlace vale por 15 minutos y funciona una sola vez. Si no lo pediste, ignora este correo.' },
  },
  he: {
    html: 'he', dir: 'rtl', fallback: 'אם הכפתור לא נפתח, העתיקו את הכתובת הזו לדפדפן:',
    verify: { subject: 'אישור החשבון שלך ב-Anubis Router', intro: 'שלום! נשאר צעד אחד להפעלת החשבון: אשרו את האימייל הזה.', action: 'אישור האימייל', note: 'הקישור תקף ל-48 שעות. אם לא יצרתם את החשבון הזה, התעלמו מהאימייל.' },
    magic: { subject: 'קישור הכניסה שלך ל-Anubis Router', intro: 'שלום! השתמשו בכפתור שלמטה כדי להיכנס לחשבון.', action: 'כניסה לחשבון', note: 'הקישור תקף ל-15 דקות ופועל פעם אחת בלבד. אם לא ביקשתם אותו, התעלמו מהאימייל.' },
  },
  ru: {
    html: 'ru', dir: 'ltr', fallback: 'Если кнопка не открывается, скопируйте этот адрес в браузер:',
    verify: { subject: 'Подтвердите аккаунт Anubis Router', intro: 'Здравствуйте! Остался один шаг до активации аккаунта: подтвердите этот email.', action: 'Подтвердить email', note: 'Ссылка действует 48 часов. Если вы не создавали этот аккаунт, просто проигнорируйте письмо.' },
    magic: { subject: 'Ваша ссылка для входа в Anubis Router', intro: 'Здравствуйте! Нажмите кнопку ниже, чтобы войти в аккаунт.', action: 'Войти в аккаунт', note: 'Ссылка действует 15 минут и срабатывает один раз. Если вы её не запрашивали, проигнорируйте письмо.' },
  },
  it: {
    html: 'it', dir: 'ltr', fallback: 'Se il pulsante non si apre, copia questo indirizzo nel browser:',
    verify: { subject: 'Conferma il tuo account Anubis Router', intro: 'Ciao! Manca un passo per attivare il tuo account: conferma questa email.', action: 'Conferma email', note: 'Il link è valido per 48 ore. Se non hai creato questo account, ignora questa email.' },
    magic: { subject: 'Il tuo link di accesso ad Anubis Router', intro: 'Ciao! Usa il pulsante qui sotto per accedere al tuo account.', action: 'Accedi', note: 'Il link è valido per 15 minuti e funziona una sola volta. Se non lo hai richiesto, ignora questa email.' },
  },
};

export function buildEmail(kind, { link, lang = 'en' }) {
  const locale = COPY[lang] || COPY.en;
  const copy = { ...locale[kind] };
  copy.intro = escape(copy.intro);
  const text = `${copy.intro.replace(/&[a-z#0-9]+;/g, m => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" })[m] || m)}\n\n${copy.action}: ${link}\n\n${copy.note}\n`;
  const html = `<!doctype html><html lang="${locale.html}" dir="${locale.dir}"><body style="margin:0;background:#fbfaf7;font-family:Segoe UI,Arial,sans-serif;color:#121212">
<div style="max-width:520px;margin:0 auto;padding:32px 24px"><p style="font-size:18px;font-weight:700;margin:0 0 20px"><img src="${escape(new URL('/brand.png', link).href)}" width="32" height="32" alt="" style="vertical-align:middle;margin-inline-end:10px;border:0;border-radius:6px"><span style="vertical-align:middle">Anubis Router</span></p>
<p style="font-size:15px;line-height:1.55;margin:0 0 24px">${copy.intro}</p>
<p style="margin:0 0 24px"><a href="${escape(link)}" style="display:inline-block;background:#121212;color:#fff;text-decoration:none;font-weight:600;padding:12px 22px;border-radius:999px">${escape(copy.action)}</a></p>
<p style="font-size:13px;line-height:1.5;color:#6b6759;margin:0 0 8px">${escape(locale.fallback)}<br><span dir="ltr" style="word-break:break-all">${escape(link)}</span></p>
<p style="font-size:13px;line-height:1.5;color:#6b6759;margin:0">${escape(copy.note)}</p></div></body></html>`;
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
