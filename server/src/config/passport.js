const passport = require('passport');
const LocalStrategy = require('passport-local').Strategy;
const bcrypt = require('bcrypt');
const prisma = require('../lib/prisma');

const MAX_ATTEMPTS = 5;
const LOCKOUT_MINUTES = 15;

passport.use(
  new LocalStrategy({ usernameField: 'email' }, async (email, password, done) => {
    try {
      const user = await prisma.user.findUnique({ where: { email: email.toLowerCase().trim() } });

      // Same generic error whether the account exists or not (no user enumeration).
      const fail = (info) => done(null, false, info);

      if (!user) {
        // Constant-ish time: burn a bcrypt compare against a dummy hash anyway.
        await bcrypt.compare(password, '$2b$12$C6UzMDM.H6dfI/f/IKcEeO7ZBpg0oQ9pKq3S3rWm0eDcXG1a2b3cO');
        return fail({ message: 'Invalid credentials' });
      }

      if (user.lockedUntil && user.lockedUntil > new Date()) {
        return fail({ message: 'Account temporarily locked. Try again later.', locked: true, userId: user.id });
      }

      const ok = await bcrypt.compare(password, user.passwordHash);
      if (!ok) {
        const attempts = user.failedAttempts + 1;
        await prisma.user.update({
          where: { id: user.id },
          data: {
            failedAttempts: attempts,
            lockedUntil:
              attempts >= MAX_ATTEMPTS ? new Date(Date.now() + LOCKOUT_MINUTES * 60 * 1000) : null,
          },
        });
        return fail({ message: 'Invalid credentials', userId: user.id });
      }

      if (user.failedAttempts > 0 || user.lockedUntil) {
        await prisma.user.update({
          where: { id: user.id },
          data: { failedAttempts: 0, lockedUntil: null },
        });
      }
      return done(null, user);
    } catch (err) {
      return done(err);
    }
  })
);

module.exports = passport;
