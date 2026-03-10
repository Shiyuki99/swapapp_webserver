const express = require('express');
const path = require('path');
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = process.env.PORT || 3000;

// ============================================================================
// IN-MEMORY SESSION STORE
// ============================================================================
// Structure: Map<sessionId, { token, profile, createdAt }>
// Profile shape: { id, name, socialLinks: { instagram, twitter, discord, ... } }
const sessions = new Map();

// Auto-cleanup expired sessions every minute (5 minute TTL)
const SESSION_TTL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_SESSIONS = 10000; // Safe cap for 2 vCPUs / 4 GB VPS (~10 MB max)
setInterval(() => {
   const now = Date.now();
   for (const [id, session] of sessions) {
      if (now - session.createdAt > SESSION_TTL_MS) {
         sessions.delete(id);
         console.log(`[CLEANUP] Expired session: ${id}`);
      }
   }
}, 60 * 1000); // Every 1 minute

// ============================================================================
// ANALYTICS & TRACKING
// ============================================================================
const fs = require('fs');
const statsFile = path.join(__dirname, 'stats.json');

let appStats = {
   totalSessionsCreated: 0,
   totalAppOpens: 0,
};

if (fs.existsSync(statsFile)) {
   try {
      const data = JSON.parse(fs.readFileSync(statsFile, 'utf8'));
      appStats.totalSessionsCreated = data.totalSessionsCreated || 0;
      appStats.totalAppOpens = data.totalAppOpens || 0;
   } catch (err) {
      console.error('Error loading stats.json:', err);
   }
}

function saveStats() {
   fs.writeFile(statsFile, JSON.stringify(appStats, null, 2), (err) => {
      if (err) console.error('Error saving stats.json:', err);
   });
}

const LATEST_APP_VERSION = '1.0.0+5'; // Defines current version

// ============================================================================
// MIDDLEWARE
// ============================================================================
app.use(express.json({ limit: '2kb' }));
app.use(express.static(path.join(__dirname, 'public'), { dotfiles: 'allow' }));

// Rate limiters (per IP)
// Session creation: stricter — max 10 per 15 minutes
const sessionCreateLimiter = rateLimit({
   windowMs: 15 * 60 * 1000,
   max: 10,
   standardHeaders: true,
   legacyHeaders: false,
   message: { error: 'Too many sessions created from this IP. Try again later.' },
});

// Page views: more relaxed — max 60 per 15 minutes
const viewLimiter = rateLimit({
   windowMs: 15 * 60 * 1000,
   max: 60,
   standardHeaders: true,
   legacyHeaders: false,
   message: { error: 'Too many requests from this IP. Try again later.' },
});

// EJS templating
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// ============================================================================
// PLATFORM CONFIG (mirrors mobile app's platform_config.dart)
// ============================================================================
const socialPlatforms = ['instagram', 'twitter', 'discord', 'snapchat', 'tiktok', 'github'];
const contactPlatforms = ['email', 'phone'];
const linkRequiredPlatforms = ['discord'];

function getSocialUrl(platform, username) {
   if (!username) return '';
   switch (platform) {
      case 'instagram': return `https://instagram.com/${username}`;
      case 'twitter': return `https://twitter.com/${username}`;
      case 'discord': return ''; // Can't construct URL from username alone
      case 'tiktok': return `https://tiktok.com/@${username}`;
      case 'snapchat': return `https://snapchat.com/add/${username}`;
      case 'github': return `https://github.com/${username}`;
      case 'email': return `mailto:${username}`;
      case 'phone': return `tel:${username}`;
      default: return '';
   }
}

function getIconFile(platform) {
   switch (platform) {
      case 'twitter': return 'twitter-x.svg';
      default: return `${platform}.svg`;
   }
}

// URL validation mimicking the mobile app
const platformUrlPrefixes = {
   'instagram': 'instagram.com/',
   'twitter': 'x.com/',
   'tiktok': 'tiktok.com/',
   'snapchat': 'snapchat.com/',
   'github': 'github.com/',
   'discord': 'discord.gg/',
};

function isValidUrlForPlatform(platform, url) {
   if (!url) return false;
   // Ensure it's a structural URL if it has a prefix requirement
   const prefix = platformUrlPrefixes[platform];
   if (!prefix) {
      return url.startsWith('http://') || url.startsWith('https://');
   }
   return url.includes(prefix);
}

// ============================================================================
// PROFILE VALIDATION & SANITIZATION
// ============================================================================
function validateAndSanitizeProfile(rawProfile) {
   if (!rawProfile || typeof rawProfile !== 'object' || Array.isArray(rawProfile)) {
      throw new Error('Profile must be a JSON object');
   }

   // 1. Validate ID
   const id = typeof rawProfile.id === 'string' ? rawProfile.id.trim().substring(0, 100) : '';

   // 2. Validate Name
   const name = typeof rawProfile.name === 'string' ? rawProfile.name.trim().substring(0, 50) : '';
   if (!name) {
      throw new Error('Profile must have a valid non-empty name');
   }

   // 3. Validate Profile Name (optional, default to Unknown)
   const profileName = typeof rawProfile.profileName === 'string'
      ? rawProfile.profileName.trim().substring(0, 50)
      : 'Unknown';

   // 4. Validate Social Links
   const rawSocials = rawProfile.socialLinks;
   if (!rawSocials || typeof rawSocials !== 'object' || Array.isArray(rawSocials)) {
      throw new Error('Profile must include a valid socialLinks object');
   }

   const cleanSocialLinks = {};
   let hasAnyValidSocial = false;

   // Cap the raw object to prevent memory abuse from thousands of keys
   const MAX_KEYS = 50;
   let keysProcessed = 0;

   // Only allow strings, limit lengths
   for (const [key, value] of Object.entries(rawSocials)) {
      if (keysProcessed++ > MAX_KEYS) break;

      if (typeof key === 'string' && typeof value === 'string') {
         const cleanKey = key.trim().substring(0, 30);
         const cleanValue = value.trim().substring(0, 2000); // Max URL length approx

         if (cleanKey && cleanValue) {
            // Apply strict domain validation if this is a custom uploaded "_link"
            if (cleanKey.endsWith('_link')) {
               const basePlatform = cleanKey.replace('_link', '');
               if (!isValidUrlForPlatform(basePlatform, cleanValue)) {
                  throw new Error(`Invalid link format for platform: ${basePlatform}`);
               }
            }

            cleanSocialLinks[cleanKey] = cleanValue;

            // Check if it's a "real" social entry (not a metadata key)
            if (!cleanKey.endsWith('_link') && !cleanKey.endsWith('_id')) {
               hasAnyValidSocial = true;
            }
         }
      }
   }

   if (!hasAnyValidSocial) {
      throw new Error('Profile must have at least one valid social platform entry');
   }

   return {
      id,
      name,
      profileName,
      socialLinks: cleanSocialLinks,
   };
}

// ============================================================================
// ROUTES
// ============================================================================

// GET / - Landing page
app.get('/', viewLimiter, (req, res) => {
   res.render('index');
});

// POST /api/session — Mobile app creates a session
// Body: { sessionId, token, profile }
app.post('/api/session', sessionCreateLimiter, (req, res) => {
   const { sessionId, token, profile } = req.body;

   if (!sessionId || !token || !profile) {
      return res.status(400).json({
         error: 'Missing required fields: sessionId, token, profile'
      });
   }

   let cleanProfile;
   try {
      cleanProfile = validateAndSanitizeProfile(profile);
   } catch (error) {
      return res.status(400).json({
         error: error.message
      });
   }

   if (sessions.size >= MAX_SESSIONS) {
      return res.status(503).json({
         error: 'Server is at capacity. Try again later.'
      });
   }

   if (sessions.has(sessionId)) {
      return res.status(409).json({
         error: 'Session ID already exists. Please regenerate and retry.'
      });
   }

   // Store session
   sessions.set(sessionId, {
      token,
      profile: cleanProfile,
      createdAt: Date.now(),
   });

   // Update tracking stats
   appStats.totalSessionsCreated++;
   saveStats();

   console.log(`[SESSION] Created: ${sessionId} for "${cleanProfile.name}" (${sessions.size} active)`);

   res.status(201).json({
      success: true,
      url: `/view/${sessionId}?sig=${token}`,
   });
});

// GET /view/:sessionId — Display profile page
app.get('/view/:sessionId', viewLimiter, (req, res) => {
   const { sessionId } = req.params;
   const { sig } = req.query;

   const session = sessions.get(sessionId);

   if (!session) {
      return res.status(404).render('error', {
         title: 'Session Not Found',
         message: 'This swap session does not exist or has expired.',
      });
   }

   if (session.token !== sig) {
      return res.status(403).render('error', {
         title: 'Unauthorized',
         message: 'Invalid or missing signature token.',
      });
   }

   // Build the platform data for the template
   const { profile } = session;
   const socialLinks = profile.socialLinks || {};

   // Filter to only platforms that have data (username OR link)
   const activeSocials = socialPlatforms
      .filter(p => {
         const username = socialLinks[p];
         const link = socialLinks[`${p}_link`];
         return (username && username.length > 0) || (link && link.length > 0);
      })
      .map(p => {
         const username = socialLinks[p] || '';
         const profileLink = socialLinks[`${p}_link`] || null;
         const constructedUrl = getSocialUrl(p, username);
         return {
            platform: p,
            username: username || profileLink || '',
            url: constructedUrl || profileLink || '',
            icon: getIconFile(p),
            profileLink,
         };
      });

   const activeContacts = contactPlatforms
      .filter(p => {
         const username = socialLinks[p];
         const link = socialLinks[`${p}_link`];
         return (username && username.length > 0) || (link && link.length > 0);
      })
      .map(p => {
         const username = socialLinks[p] || '';
         const profileLink = socialLinks[`${p}_link`] || null;
         return {
            platform: p,
            username: username || profileLink || '',
            url: getSocialUrl(p, username) || profileLink || '',
            icon: getIconFile(p),
         };
      });

   res.render('session', {
      profile,
      activeSocials,
      activeContacts,
      socialPlatforms,
      contactPlatforms,
      allSocialLinks: socialLinks,
      getIconFile,
      getSocialUrl,
   });
});

// GET /api/session/:sessionId — JSON API (for potential future use)
app.get('/api/session/:sessionId', viewLimiter, (req, res) => {
   const { sessionId } = req.params;
   const { sig } = req.query;

   const session = sessions.get(sessionId);

   if (!session) {
      return res.status(404).json({ error: 'Session not found' });
   }

   if (session.token !== sig) {
      return res.status(403).json({ error: 'Invalid token' });
   }

   res.json({
      profile: session.profile,
      createdAt: session.createdAt,
   });
});

// DELETE /api/session/:sessionId — Mobile app cancels a session
app.delete('/api/session/:sessionId', viewLimiter, (req, res) => {
   const { sessionId } = req.params;
   const { sig } = req.query;

   const session = sessions.get(sessionId);

   if (!session) {
      return res.status(404).json({ error: 'Session not found' });
   }

   if (session.token !== sig) {
      return res.status(403).json({ error: 'Invalid token' });
   }

   sessions.delete(sessionId);
   console.log(`[SESSION] Cancelled: ${sessionId} (${sessions.size} active)`);

   res.json({ success: true });
});

// GET /api/stats — View tracking data (JSON)
app.get('/api/stats', viewLimiter, (req, res) => {
   res.json({
      totalSessionsCreated: appStats.totalSessionsCreated,
      totalAppOpens: appStats.totalAppOpens,
   });
});

// GET /stats — View tracking data (UI)
app.get('/stats', viewLimiter, (req, res) => {
   res.render('stats', {
      stats: {
         totalSessionsCreated: appStats.totalSessionsCreated,
         totalAppOpens: appStats.totalAppOpens,
      }
   });
});

// Health check
app.get('/health', (req, res) => {
   res.json({ status: 'ok', sessions: sessions.size });
});

// ============================================================================
// APP UPDATE ENDPOINTS
// ============================================================================

/**
 * Parse a version string of the form "X.Y.Z+B" into numeric components.
 * Returns null if the format is invalid.
 */
function parseVersion(versionStr) {
   const match = versionStr.trim().match(/^(\d+)\.(\d+)\.(\d+)(?:\+(\d+))?$/);
   if (!match) return null;
   return {
      major: parseInt(match[1], 10),
      minor: parseInt(match[2], 10),
      patch: parseInt(match[3], 10),
      build: parseInt(match[4] || '0', 10),
   };
}

/**
 * Returns true if version `a` is strictly older than version `b`.
 */
function isOlderVersion(a, b) {
   if (a.major !== b.major) return a.major < b.major;
   if (a.minor !== b.minor) return a.minor < b.minor;
   if (a.patch !== b.patch) return a.patch < b.patch;
   return a.build < b.build;
}

app.get('/api/check-update', (req, res) => {
   const clientVersion = req.query.version;

   if (!clientVersion || typeof clientVersion !== 'string') {
      return res.status(400).json({ error: 'Missing or invalid version query parameter' });
   }

   // Count every check-update call as an app open (app calls this on launch)
   appStats.totalAppOpens++;
   saveStats();

   const client = parseVersion(clientVersion);
   const latest = parseVersion(LATEST_APP_VERSION);

   if (!client || !latest) {
      // If we can't parse versions, fall back to equality check
      return res.json({
         updateAvailable: clientVersion !== LATEST_APP_VERSION,
         latestVersion: LATEST_APP_VERSION,
      });
   }

   // Only prompt for update when the client version is strictly older
   const updateAvailable = isOlderVersion(client, latest);

   res.json({
      updateAvailable,
      latestVersion: LATEST_APP_VERSION,
   });
});

// ============================================================================
// START SERVER
// ============================================================================
app.listen(PORT, '0.0.0.0', () => {
   console.log(`\n  🔄 SWAP Web Server running at http://0.0.0.0:${PORT}\n`);
   console.log(`  Routes:`);
   console.log(`    POST /api/session          — Create session (from mobile app)`);
   console.log(`    GET  /view/:sessionId       — View profile page`);
   console.log(`    GET  /api/session/:sessionId — Get session data (JSON)`);
   console.log(`    GET  /api/check-update     — Check for app updates (tracks opens)`);
   console.log(`    GET  /api/stats            — View usage statistics\n`);
});
