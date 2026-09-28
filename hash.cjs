const bcrypt = require("bcryptjs");

async function generateHash() {
  const plainPassword = "1234";
  const saltRounds = 10; // recommended cost factor
  const hash = await bcrypt.hash(plainPassword, saltRounds);

  console.log("Plain:", plainPassword);
  console.log("Hashed:", hash);
}

generateHash();
