const nodemailer = require('nodemailer');
const logger = require('./logger');

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT || 587),
  secure: Number(process.env.SMTP_PORT) === 465,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

async function sendPasswordResetEmail(to, resetUrl) {
  try {
    await transporter.sendMail({
      from: process.env.EMAIL_FROM,
      to,
      subject: 'Reset your OpsShield password',
      text: `We received a request to reset your OpsShield password. This link expires in 30 minutes and can only be used once:\n\n${resetUrl}\n\nIf you did not request this, you can safely ignore this email — your password will not be changed.`,
      html: `
        <p>We received a request to reset your OpsShield password.</p>
        <p><a href="${resetUrl}">Reset your password</a></p>
        <p>This link expires in 30 minutes and can only be used once.</p>
        <p>If you did not request this, you can safely ignore this email — your password will not be changed.</p>
      `,
    });
  } catch (err) {
    // Never let email delivery failure leak into the request/response cycle
    // or reveal account existence — log server-side only.
    logger.error('Password reset email failed to send', { err: err.message });
  }
}

// Unlike sendPasswordResetEmail, this one *rethrows* on failure. An invite
// with no way for the invitee to ever see it is a dangling, useless row —
// the controller relies on this throwing so it can roll back the invite
// rather than leaving an unreachable invite in the database.
async function sendInvite({ to, inviteUrl, role }) {
  await transporter.sendMail({
    from: process.env.EMAIL_FROM,
    to,
    subject: `You've been invited to join an OpsShield organisation`,
    text: `You've been invited to join an OpsShield organisation as a ${role}. Accept your invite here (expires in 7 days):\n\n${inviteUrl}`,
    html: `
      <p>You've been invited to join an OpsShield organisation as a <strong>${role}</strong>.</p>
      <p><a href="${inviteUrl}">Accept your invite</a></p>
      <p>This link expires in 7 days.</p>
    `,
  });
}

module.exports = { sendPasswordResetEmail, sendInvite };
