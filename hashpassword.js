// hashPassword.js
const bcrypt = require('bcryptjs');

const password = 'ujultimuate'; // your desired password
const saltRounds = 12; // recommended

bcrypt.hash(password, saltRounds, (err, hash) => {
  if (err) {
    console.error('Error hashing password:', err);
    return;
  }
  console.log('Hashed password:', hash);
});
