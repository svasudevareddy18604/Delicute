const brevo = require("@getbrevo/brevo");

const apiInstance = new brevo.TransactionalEmailsApi();

apiInstance.setApiKey(
  brevo.TransactionalEmailsApiApiKeys.apiKey,
  process.env.BREVO_API_KEY
);

async function sendEmail({ to, subject, html }) {
  const email = new brevo.SendSmtpEmail();

  email.sender = {
    name: "Delicute",
    email: process.env.EMAIL_USER,
  };

  email.to = [
    {
      email: to,
    },
  ];

  email.subject = subject;
  email.htmlContent = html;

  return apiInstance.sendTransacEmail(email);
}

module.exports = { sendEmail };