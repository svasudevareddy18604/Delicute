const brevo = require("@getbrevo/brevo");

const apiInstance = new brevo.TransactionalEmailsApi();

apiInstance.setApiKey(
  brevo.TransactionalEmailsApiApiKeys.apiKey,
  process.env.BREVO_API_KEY
);

async function sendEmail({ to, subject, html }) {
  const sendSmtpEmail = new brevo.SendSmtpEmail();

  sendSmtpEmail.subject = subject;

  sendSmtpEmail.sender = {
    name: "Delicute",
    email: process.env.EMAIL_USER,
  };

  sendSmtpEmail.to = [
    {
      email: to,
    },
  ];

  sendSmtpEmail.htmlContent = html;

  return await apiInstance.sendTransacEmail(sendSmtpEmail);
}

module.exports = {
  sendEmail,
};