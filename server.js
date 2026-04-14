'use strict';
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ── Load .env ─────────────────────────────────────────────────────────────────
try {
  fs.readFileSync(path.join(__dirname, '.env'), 'utf8')
    .split('\n')
    .forEach(line => {
      const eq = line.indexOf('=');
      if (eq > 0 && !line.trim().startsWith('#')) {
        const k = line.slice(0, eq).trim();
        const v = line.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
        if (!process.env[k]) process.env[k] = v;
      }
    });
} catch {}

const PORT = parseInt(process.env.PORT || '3001', 10);
const API_KEY    = process.env.ANTHROPIC_API_KEY || '';
const GROK_KEY   = process.env.GROK_API_KEY || '';
const USE_GROK   = !!GROK_KEY;

// ── SSE Registry ──────────────────────────────────────────────────────────────
const clients = new Map(); // clientId → { res, roomCode }

function sendTo(clientId, event, data) {
  const conn = clients.get(clientId);
  if (!conn || conn.res.writableEnded) return;
  conn.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function broadcast(roomCode, event, data) {
  for (const [id, conn] of clients) {
    if (conn.roomCode === roomCode) sendTo(id, event, data);
  }
}

// ── Room Management ───────────────────────────────────────────────────────────
const AVATARS = ['🦊','🐼','🦁','🐸','🦄','🐯','🦋','🐙','🦀','🐬'];
const WORDS   = ['TIGER','NOVA','BLAZE','STORM','PIXEL','TURBO','MEGA','HYPER',
                 'ROCKET','COMET','FLASH','SONIC','BLITZ','NEON','LASER','VIPER'];
const rooms   = new Map(); // roomCode → Room

function genCode() {
  let code;
  do {
    code = `${WORDS[Math.random() * WORDS.length | 0]}-${(Math.random() * 90 | 0) + 10}`;
  } while (rooms.has(code));
  return code;
}

function makePlayer(clientId, name, avatar) {
  return { clientId, name, avatar, score: 0, scoreHistory: [], isConnected: true };
}

function createRoom(hostClientId, playerName, settings) {
  const code = genCode();
  const room = {
    code, hostClientId,
    phase: 'lobby',
    settings: {
      topic: settings?.topic || 'general',
      customTopic: settings?.customTopic || null,
      difficulty: settings?.difficulty || 'medium',
      totalRounds: settings?.totalRounds || 10,
    },
    players: new Map(),
    questions: [], currentQuestionIndex: 0,
    questionDeadline: null,
    timerHandle: null, revealHandle: null, leaderboardHandle: null, cleanupHandle: null,
    answersReceived: new Map(),
    usedQuestions: new Set(),
  };
  room.players.set(hostClientId, makePlayer(hostClientId, playerName, AVATARS[0]));
  rooms.set(code, room);
  return room;
}

function addPlayer(room, clientId, name) {
  const used = new Set([...room.players.values()].map(p => p.avatar));
  const avatar = AVATARS.find(a => !used.has(a)) || AVATARS[room.players.size % AVATARS.length];
  const p = makePlayer(clientId, name, avatar);
  room.players.set(clientId, p);
  return p;
}

function clearRoomTimers(room) {
  clearTimeout(room.timerHandle);
  clearTimeout(room.revealHandle);
  clearTimeout(room.leaderboardHandle);
  clearTimeout(room.cleanupHandle);
}

function deleteRoom(code) {
  const room = rooms.get(code);
  if (room) { clearRoomTimers(room); rooms.delete(code); }
}

function playerList(room) {
  return [...room.players.values()].map(({ clientId, name, avatar, score, isConnected }) =>
    ({ clientId, name, avatar, score, isConnected }));
}

function ranked(room) {
  return [...room.players.values()]
    .sort((a, b) => b.score - a.score)
    .map((p, i) => ({ rank: i + 1, clientId: p.clientId, name: p.name, avatar: p.avatar,
                      score: p.score, scoreHistory: p.scoreHistory, isConnected: p.isConnected }));
}

function connected(room) {
  return [...room.players.values()].filter(p => p.isConnected);
}

function findRoom(clientId) {
  for (const room of rooms.values())
    if (room.players.has(clientId)) return room;
  return null;
}

// ── Scoring ───────────────────────────────────────────────────────────────────
function calcPoints(isCorrect, timeRemaining) {
  if (!isCorrect) return { speedBonus: 0, total: 0 };
  const bonus = Math.round((Math.max(0, Math.min(timeRemaining, 15)) / 15) * 5);
  return { speedBonus: bonus, total: 10 + bonus };
}

// ── AI API (Claude or Grok) ───────────────────────────────────────────────────
function grokRequest(system, user, maxTokens) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: 'llama-3.3-70b-versatile', max_tokens: maxTokens,
      messages: [
        { role: 'system', content: system },
        { role: 'user',   content: user   },
      ],
    });
    const req = https.request({
      hostname: 'api.groq.com', path: '/openai/v1/chat/completions', method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'Authorization': `Bearer ${GROK_KEY}`,
      },
    }, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(raw);
          if (parsed.error) return reject(new Error(parsed.error.message));
          resolve(parsed.choices[0].message.content.trim());
        } catch (e) { reject(e); }
      });
    });
    req.setTimeout(8000, () => { req.destroy(new Error('Groq request timed out')); });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function claudeRequest(system, user, maxTokens) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: 'claude-sonnet-4-6', max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: user }],
    });
    const req = https.request({
      hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'anthropic-version': '2023-06-01',
        'x-api-key': API_KEY,
      },
    }, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(raw);
          if (parsed.error) return reject(new Error(parsed.error.message));
          resolve(parsed.content[0].text.trim());
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function callClaude(system, user, maxTokens = 4096) {
  for (let i = 0; i < 3; i++) {
    try {
      const text = USE_GROK
        ? await grokRequest(system, user, maxTokens)
        : await claudeRequest(system, user, maxTokens);
      const clean = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
      return JSON.parse(clean);
    } catch (e) {
      if (i === 2) throw e;
      await new Promise(r => setTimeout(r, (i + 1) * 1200));
    }
  }
}

// ── Built-in Question Bank (no API key needed) ────────────────────────────────
const LOCAL_QUESTIONS = {
  general: [
    { text:'What is the capital of France?', options:{A:'London',B:'Berlin',C:'Paris',D:'Rome'}, correctAnswer:'C', difficulty:'easy', explanation:'Fun fact: Paris has been the capital of France since 987 AD and is home to over 2 million people in the city proper.' },
    { text:'How many sides does a hexagon have?', options:{A:'5',B:'7',C:'8',D:'6'}, correctAnswer:'D', difficulty:'easy', explanation:'Fun fact: Hexagons are nature\'s favourite shape — honeycombs are made of hexagonal cells because they\'re the most space-efficient shape.' },
    { text:'Which planet is closest to the Sun?', options:{A:'Venus',B:'Earth',C:'Mars',D:'Mercury'}, correctAnswer:'D', difficulty:'easy', explanation:'Fun fact: Mercury is so close to the Sun that a year there lasts only 88 Earth days, yet its surface temperature swings from -180°C to 430°C.' },
    { text:'How many continents are on Earth?', options:{A:'5',B:'6',C:'8',D:'7'}, correctAnswer:'D', difficulty:'easy', explanation:'Fun fact: Antarctica is a continent even though no country owns it — it\'s governed by the Antarctic Treaty signed by 54 nations.' },
    { text:'What is the largest ocean on Earth?', options:{A:'Atlantic',B:'Indian',C:'Arctic',D:'Pacific'}, correctAnswer:'D', difficulty:'easy', explanation:'Fun fact: The Pacific Ocean is so large it covers more area than all the world\'s landmasses combined.' },
    { text:'What element has the chemical symbol Au?', options:{A:'Silver',B:'Copper',C:'Gold',D:'Aluminum'}, correctAnswer:'C', difficulty:'medium', explanation:'Fun fact: Au comes from the Latin word "aurum". Gold has been used as currency for over 6,000 years and never tarnishes.' },
    { text:'In what year did World War II end?', options:{A:'1943',B:'1944',C:'1946',D:'1945'}, correctAnswer:'D', difficulty:'medium', explanation:'Fun fact: World War II ended on September 2, 1945, when Japan formally surrendered aboard the USS Missouri in Tokyo Bay.' },
    { text:'Who wrote Romeo and Juliet?', options:{A:'Charles Dickens',B:'Mark Twain',C:'Jane Austen',D:'William Shakespeare'}, correctAnswer:'D', difficulty:'medium', explanation:'Fun fact: Shakespeare wrote Romeo and Juliet around 1594–1596, but the story itself was based on an Italian tale from 1530.' },
    { text:'What is the longest river in the world?', options:{A:'Amazon',B:'Mississippi',C:'Nile',D:'Yangtze'}, correctAnswer:'C', difficulty:'medium', explanation:'Fun fact: The Nile stretches 6,650 km through 11 countries. It flows northward, which is unusual — most rivers flow south.' },
    { text:'How many teeth does a typical adult human have?', options:{A:'28',B:'30',C:'34',D:'32'}, correctAnswer:'D', difficulty:'medium', explanation:'Fun fact: 32 teeth includes 4 wisdom teeth. About 35% of people never develop wisdom teeth at all — a genuine evolutionary trend.' },
    { text:'What gas do plants absorb during photosynthesis?', options:{A:'Oxygen',B:'Nitrogen',C:'Hydrogen',D:'Carbon dioxide'}, correctAnswer:'D', difficulty:'easy', explanation:'Fun fact: A single mature tree can absorb up to 22 kg of CO₂ per year and produce enough oxygen for two people to breathe.' },
    { text:'What is the smallest country in the world by area?', options:{A:'Monaco',B:'Nauru',C:'San Marino',D:'Vatican City'}, correctAnswer:'D', difficulty:'hard', explanation:'Fun fact: Vatican City is only 0.44 km² — smaller than most golf courses — yet it has its own postal system, radio station, and army.' },
    { text:'In which year was the first iPhone released?', options:{A:'2005',B:'2006',C:'2008',D:'2007'}, correctAnswer:'D', difficulty:'hard', explanation:'Fun fact: Steve Jobs revealed the first iPhone on January 9, 2007, describing it as "an iPod, a phone, and an internet communicator" — three devices in one.' },
    { text:'What is the speed of light in a vacuum?', options:{A:'150,000 km/s',B:'200,000 km/s',C:'400,000 km/s',D:'300,000 km/s'}, correctAnswer:'D', difficulty:'hard', explanation:'Fun fact: Light travels at exactly 299,792,458 metres per second — so fast it circles Earth 7.5 times every second.' },
    { text:'Which country invented pizza?', options:{A:'Spain',B:'Greece',C:'France',D:'Italy'}, correctAnswer:'D', difficulty:'easy', explanation:'Fun fact: The modern pizza was invented in Naples, Italy around 1800. The Margherita pizza was named after Queen Margherita of Savoy in 1889.' },
    { text:'What is the tallest mountain in the world?', options:{A:'K2',B:'Kangchenjunga',C:'Lhotse',D:'Mount Everest'}, correctAnswer:'D', difficulty:'easy', explanation:'Fun fact: Mount Everest is 8,849 m tall and grows about 4mm per year due to tectonic activity. It was first summited in 1953.' },
    { text:'Which is the most spoken language in the world by native speakers?', options:{A:'English',B:'Hindi',C:'Spanish',D:'Mandarin Chinese'}, correctAnswer:'D', difficulty:'medium', explanation:'Fun fact: Mandarin has roughly 920 million native speakers. However, English is the most widely spoken when including second-language speakers.' },
    { text:'What is the currency of Japan?', options:{A:'Yuan',B:'Won',C:'Baht',D:'Yen'}, correctAnswer:'D', difficulty:'easy', explanation:'Fun fact: The word "yen" means "round object" in Japanese. Japan has one of the oldest continuously used currencies in the world.' },
    { text:'How many bones are in an adult human body?', options:{A:'196',B:'206',C:'216',D:'226'}, correctAnswer:'B', difficulty:'medium', explanation:'Fun fact: Babies are born with around 270–300 bones, but many fuse together during growth, leaving adults with 206.' },
    { text:'What is the hardest natural substance on Earth?', options:{A:'Steel',B:'Quartz',C:'Titanium',D:'Diamond'}, correctAnswer:'D', difficulty:'easy', explanation:'Fun fact: Diamond scores 10 on the Mohs hardness scale. It\'s so hard that only another diamond can cut it — which is exactly how diamonds are polished.' },
  ],
  movies: [
    { text:'Who voiced Woody in the Toy Story franchise?', options:{A:'Tom Cruise',B:'Will Smith',C:'Brad Pitt',D:'Tom Hanks'}, correctAnswer:'D', difficulty:'easy', explanation:'Fun fact: Tom Hanks has voiced Woody in all four Toy Story films and several short films since 1995.' },
    { text:'In Star Wars, what colour is Luke Skywalker\'s first lightsaber?', options:{A:'Red',B:'Green',C:'Purple',D:'Blue'}, correctAnswer:'D', difficulty:'easy', explanation:'Fun fact: The blue lightsaber was originally Anakin Skywalker\'s, passed to Luke in A New Hope, then Rey in The Force Awakens.' },
    { text:'Which film features the quote "I\'ll be back"?', options:{A:'RoboCop',B:'Total Recall',C:'The Terminator',D:'Predator'}, correctAnswer:'C', difficulty:'easy', explanation:'Fun fact: Arnold Schwarzenegger initially argued the line should be "I\'ll come back" — but director James Cameron insisted on "I\'ll be back."' },
    { text:'What colour pill does Neo take in The Matrix?', options:{A:'Blue',B:'Green',C:'Yellow',D:'Red'}, correctAnswer:'D', difficulty:'easy', explanation:'Fun fact: The red pill represents truth and reality, while the blue pill represents blissful ignorance. The Wachowskis drew inspiration from Alice in Wonderland.' },
    { text:'Who directed Jurassic Park?', options:{A:'James Cameron',B:'George Lucas',C:'Christopher Nolan',D:'Steven Spielberg'}, correctAnswer:'D', difficulty:'medium', explanation:'Fun fact: Spielberg directed Jurassic Park in 1993 while simultaneously editing Schindler\'s List remotely — both were released the same year.' },
    { text:'Which film won the Academy Award for Best Picture in 2020?', options:{A:'1917',B:'Joker',C:'Ford v Ferrari',D:'Parasite'}, correctAnswer:'D', difficulty:'medium', explanation:'Fun fact: Parasite by Bong Joon-ho was the first non-English language film to win Best Picture in the 92-year history of the Oscars.' },
    { text:'Who played the Joker in The Dark Knight?', options:{A:'Joaquin Phoenix',B:'Jared Leto',C:'Jack Nicholson',D:'Heath Ledger'}, correctAnswer:'D', difficulty:'easy', explanation:'Fun fact: Heath Ledger won the Academy Award for Best Supporting Actor posthumously for this role — the second person ever to do so.' },
    { text:'What animated film features the songs "Let It Go" and "Do You Want to Build a Snowman"?', options:{A:'Tangled',B:'Brave',C:'Moana',D:'Frozen'}, correctAnswer:'D', difficulty:'easy', explanation:'Fun fact: Frozen became the highest-grossing animated film of all time when it was released in 2013, and held that record for six years.' },
    { text:'Who composed the score for the Star Wars franchise?', options:{A:'Hans Zimmer',B:'Danny Elfman',C:'Ennio Morricone',D:'John Williams'}, correctAnswer:'D', difficulty:'medium', explanation:'Fun fact: John Williams has been nominated for 54 Academy Awards — the most nominations of any living person — and won 5.' },
    { text:'In which film does a character say "To infinity and beyond!"?', options:{A:'Toy Story',B:'WALL-E',C:'Up',D:'The Incredibles'}, correctAnswer:'A', difficulty:'easy', explanation:'Fun fact: Buzz Lightyear\'s iconic catchphrase was almost cut from early drafts of the script. Thankfully, it stayed.' },
    { text:'Which country produced the movie Parasite?', options:{A:'Japan',B:'China',C:'Taiwan',D:'South Korea'}, correctAnswer:'D', difficulty:'medium', explanation:'Fun fact: Parasite was the first Korean film to be submitted for — and win — the Palme d\'Or at the Cannes Film Festival.' },
    { text:'What is the highest-grossing film of all time (without adjusting for inflation)?', options:{A:'Titanic',B:'Avatar: The Way of Water',C:'Avengers: Endgame',D:'Avatar'}, correctAnswer:'D', difficulty:'hard', explanation:'Fun fact: Avatar (2009) earned over $2.9 billion worldwide. James Cameron re-released it in 2022 to reclaim the top spot from Avengers: Endgame.' },
    { text:'Who played Iron Man in the Marvel Cinematic Universe?', options:{A:'Chris Evans',B:'Chris Hemsworth',C:'Mark Ruffalo',D:'Robert Downey Jr.'}, correctAnswer:'D', difficulty:'easy', explanation:'Fun fact: Robert Downey Jr. was considered a risky casting choice due to his troubled past, but his portrayal of Tony Stark defined the MCU for over a decade.' },
    { text:'In The Wizard of Oz, what does Dorothy click together to return home?', options:{A:'Golden shoes',B:'Silver heels',C:'Glass slippers',D:'Ruby slippers'}, correctAnswer:'D', difficulty:'medium', explanation:'Fun fact: In the original book, Dorothy\'s slippers were silver. They were changed to ruby red for the 1939 film to take advantage of Technicolor.' },
    { text:'What year was the original Jaws released?', options:{A:'1973',B:'1974',C:'1976',D:'1975'}, correctAnswer:'D', difficulty:'hard', explanation:'Fun fact: Jaws (1975) is considered the first "summer blockbuster." Steven Spielberg almost quit due to mechanical shark problems — ironically, showing less shark made it scarier.' },
    { text:'Which film features the fictional African country of Wakanda?', options:{A:'Thor',B:'Captain America',C:'Iron Man',D:'Black Panther'}, correctAnswer:'D', difficulty:'easy', explanation:'Fun fact: Black Panther (2018) was the first superhero film nominated for the Academy Award for Best Picture.' },
    { text:'Who directed Pulp Fiction?', options:{A:'Martin Scorsese',B:'David Fincher',C:'Joel Coen',D:'Quentin Tarantino'}, correctAnswer:'D', difficulty:'medium', explanation:'Fun fact: Pulp Fiction won the Palme d\'Or at Cannes in 1994 and is credited with revitalizing John Travolta\'s career.' },
    { text:'What is the name of the clownfish in Finding Nemo?', options:{A:'Finn',B:'Nemo',C:'Coral',D:'Gil'}, correctAnswer:'B', difficulty:'easy', explanation:'Fun fact: Pixar\'s marine biologist consultants confirmed that in real life, if Nemo\'s mother died, his father Marlin would actually change sex to female.' },
    { text:'In Inception, how do characters know they\'re in a dream?', options:{A:'They can fly',B:'Time moves slowly',C:'They use a totem',D:'Everything is blurry'}, correctAnswer:'C', difficulty:'medium', explanation:'Fun fact: Each character has a personal totem — Cobb\'s spinning top is the most famous. The film\'s ambiguous ending hinges on whether it keeps spinning.' },
    { text:'Which studio produced the Toy Story franchise?', options:{A:'DreamWorks',B:'Warner Bros',C:'Sony Pictures',D:'Pixar'}, correctAnswer:'D', difficulty:'easy', explanation:'Fun fact: Toy Story (1995) was the world\'s first entirely computer-animated feature film. It took four years to make and cost $30 million.' },
  ],
  sports: [
    { text:'How many players are on the court for one basketball team?', options:{A:'4',B:'6',C:'7',D:'5'}, correctAnswer:'D', difficulty:'easy', explanation:'Fun fact: Basketball was invented by Dr. James Naismith in 1891 with a peach basket and a soccer ball. The first game had 18 players — 9 per side.' },
    { text:'In golf, what is the term for one stroke under par?', options:{A:'Eagle',B:'Bogey',C:'Par',D:'Birdie'}, correctAnswer:'D', difficulty:'easy', explanation:'Fun fact: The term "birdie" originated in 1899 in Atlantic City when Ab Smith called a great shot "a bird of a shot" — and the name stuck.' },
    { text:'How many players are on a football (soccer) team on the field?', options:{A:'9',B:'10',C:'12',D:'11'}, correctAnswer:'D', difficulty:'easy', explanation:'Fun fact: The 11-a-side format for association football was standardised in the Football Association rules of 1863 — the same year the FA was founded.' },
    { text:'What colour jersey does the leader wear in the Tour de France?', options:{A:'Green',B:'White',C:'Red',D:'Yellow'}, correctAnswer:'D', difficulty:'easy', explanation:'Fun fact: The yellow jersey (maillot jaune) was introduced in 1919 to make the race leader easily visible to roadside spectators.' },
    { text:'Which country has won the most FIFA World Cup titles?', options:{A:'Germany',B:'Argentina',C:'Italy',D:'Brazil'}, correctAnswer:'D', difficulty:'medium', explanation:'Fun fact: Brazil has won the World Cup 5 times (1958, 1962, 1970, 1994, 2002) and is the only country to have qualified for every single tournament.' },
    { text:'How often are the Summer Olympic Games held?', options:{A:'Every 2 years',B:'Every 3 years',C:'Every 5 years',D:'Every 4 years'}, correctAnswer:'D', difficulty:'easy', explanation:'Fun fact: The 4-year cycle is called an "Olympiad." The ancient Greeks used it to mark time — they would declare truces between city-states during the games.' },
    { text:'Who holds the record for most Olympic gold medals?', options:{A:'Carl Lewis',B:'Usain Bolt',C:'Mark Spitz',D:'Michael Phelps'}, correctAnswer:'D', difficulty:'medium', explanation:'Fun fact: Michael Phelps won 23 Olympic gold medals over four Games. In 2016 he tied the record for most medals won in a single Games with 6.' },
    { text:'In which city were the first modern Olympic Games held?', options:{A:'London',B:'Paris',C:'Stockholm',D:'Athens'}, correctAnswer:'D', difficulty:'medium', explanation:'Fun fact: The 1896 Athens Olympics had 241 athletes from 14 nations competing in 43 events. Today the Olympics feature over 10,000 athletes from 200+ nations.' },
    { text:'What is the maximum score in a perfect game of bowling?', options:{A:'200',B:'250',C:'350',D:'300'}, correctAnswer:'D', difficulty:'medium', explanation:'Fun fact: A perfect 300 requires 12 consecutive strikes. The odds of an average bowler rolling a perfect game are approximately 1 in 11,500.' },
    { text:'In cricket, how many balls are in a standard over?', options:{A:'4',B:'5',C:'8',D:'6'}, correctAnswer:'D', difficulty:'medium', explanation:'Fun fact: Cricket overs have had 4, 5, 8, and 6 balls at various points in history. The 6-ball over became universal in 1979.' },
    { text:'Which boxer was known as "The Greatest"?', options:{A:'Mike Tyson',B:'Joe Frazier',C:'George Foreman',D:'Muhammad Ali'}, correctAnswer:'D', difficulty:'easy', explanation:'Fun fact: Muhammad Ali coined the phrase "I am the greatest" before he even won the heavyweight championship — pure confidence that became prophecy.' },
    { text:'How long is a marathon in miles (approximately)?', options:{A:'24 miles',B:'28 miles',C:'30 miles',D:'26.2 miles'}, correctAnswer:'D', difficulty:'medium', explanation:'Fun fact: The exact distance of 26.219 miles was set at the 1908 London Olympics to accommodate the British royal family — the course started at Windsor Castle and ended in front of the royal box.' },
    { text:'In baseball, how many strikes does it take to strike out a batter?', options:{A:'2',B:'4',C:'5',D:'3'}, correctAnswer:'D', difficulty:'easy', explanation:'Fun fact: The three-strike rule dates to 1858. Before that, batters had to be hit by the pitched ball to be out — strikes weren\'t a thing yet.' },
    { text:'Which team has won the most Super Bowls?', options:{A:'Dallas Cowboys',B:'San Francisco 49ers',C:'Pittsburgh Steelers',D:'New England Patriots'}, correctAnswer:'D', difficulty:'hard', explanation:'Fun fact: The New England Patriots have appeared in 11 Super Bowls and won 6, all with Bill Belichick as head coach and (most of) Tom Brady as quarterback.' },
    { text:'What is the national sport of Japan?', options:{A:'Judo',B:'Baseball',C:'Karate',D:'Sumo'}, correctAnswer:'D', difficulty:'medium', explanation:'Fun fact: Sumo wrestling has been practiced in Japan for over 1,500 years. Professional sumo wrestlers (rikishi) follow a highly regimented lifestyle dictated by their stable master.' },
    { text:'In tennis, what is the score called when both players have 40 points?', options:{A:'Tie',B:'Draw',C:'Fault',D:'Deuce'}, correctAnswer:'D', difficulty:'easy', explanation:'Fun fact: "Deuce" comes from the French "à deux le jeu" meaning "to both the game." From deuce, a player must win two consecutive points to win the game.' },
    { text:'How many holes are in a standard round of golf?', options:{A:'12',B:'15',C:'21',D:'18'}, correctAnswer:'D', difficulty:'easy', explanation:'Fun fact: The 18-hole standard was set by the Royal and Ancient Golf Club of St Andrews in 1764 when they reduced their course from 22 to 18 holes.' },
    { text:'What sport uses a "shuttlecock"?', options:{A:'Squash',B:'Volleyball',C:'Table Tennis',D:'Badminton'}, correctAnswer:'D', difficulty:'easy', explanation:'Fun fact: A shuttlecock can travel at over 400 km/h when smashed — making badminton the fastest racket sport in the world.' },
    { text:'Which country won the first FIFA Women\'s World Cup in 1991?', options:{A:'Germany',B:'Norway',C:'Brazil',D:'USA'}, correctAnswer:'D', difficulty:'hard', explanation:'Fun fact: The USA beat Norway 2-1 in the final of the inaugural Women\'s World Cup held in China. The US has won the tournament a record 4 times.' },
    { text:'In which sport would you perform a "slam dunk"?', options:{A:'Volleyball',B:'Water Polo',C:'Handball',D:'Basketball'}, correctAnswer:'D', difficulty:'easy', explanation:'Fun fact: The slam dunk was banned by the NCAA from 1967 to 1976, largely because Lew Alcindor (later Kareem Abdul-Jabbar) was so dominant at it.' },
  ],
  science: [
    { text:'What force keeps us on the ground?', options:{A:'Magnetism',B:'Electricity',C:'Friction',D:'Gravity'}, correctAnswer:'D', difficulty:'easy', explanation:'Fun fact: Gravity is the weakest of the four fundamental forces, yet it has infinite range. It\'s so weak that a fridge magnet can overcome Earth\'s entire gravitational pull on a paperclip.' },
    { text:'How many planets are in our solar system?', options:{A:'7',B:'9',C:'10',D:'8'}, correctAnswer:'D', difficulty:'easy', explanation:'Fun fact: Pluto was reclassified as a "dwarf planet" in 2006 by the International Astronomical Union, reducing the planet count from 9 to 8. Pluto fans were not happy.' },
    { text:'What is the closest star to Earth?', options:{A:'Alpha Centauri',B:'Betelgeuse',C:'Sirius',D:'The Sun'}, correctAnswer:'D', difficulty:'easy', explanation:'Fun fact: The Sun is just 150 million km away. The next nearest star, Proxima Centauri, is 40 trillion km away — so far that light takes 4.2 years to reach us.' },
    { text:'What is the chemical symbol for water?', options:{A:'WA',B:'WT',C:'HO',D:'H₂O'}, correctAnswer:'D', difficulty:'easy', explanation:'Fun fact: Water is one of the few substances that expands when it freezes. This is why ice floats — and why pipes burst in winter.' },
    { text:'What is the atomic number of carbon?', options:{A:'4',B:'8',C:'12',D:'6'}, correctAnswer:'D', difficulty:'medium', explanation:'Fun fact: Carbon is the basis of all known life. It can form more compounds than any other element — over 10 million carbon-based compounds are known.' },
    { text:'Which scientist developed the special theory of relativity?', options:{A:'Isaac Newton',B:'Niels Bohr',C:'Max Planck',D:'Albert Einstein'}, correctAnswer:'D', difficulty:'medium', explanation:'Fun fact: Einstein published his special theory of relativity in 1905, the same year he wrote four other groundbreaking papers. Historians call it his "miracle year."' },
    { text:'What does DNA stand for?', options:{A:'Dioxynucleic acid',B:'Deribonucleic acid',C:'Diribonucleotide acid',D:'Deoxyribonucleic acid'}, correctAnswer:'D', difficulty:'medium', explanation:'Fun fact: DNA was first isolated in 1869 by Friedrich Miescher, but its double-helix structure wasn\'t discovered until 1953 by Watson, Crick, Franklin, and Wilkins.' },
    { text:'What is the powerhouse of the cell?', options:{A:'Nucleus',B:'Ribosome',C:'Chloroplast',D:'Mitochondria'}, correctAnswer:'D', difficulty:'easy', explanation:'Fun fact: Mitochondria have their own DNA separate from the cell\'s nucleus, which supports the theory that they were once free-living bacteria absorbed by larger cells over a billion years ago.' },
    { text:'What is the half-life of Carbon-14?', options:{A:'1,570 years',B:'14,000 years',C:'57,000 years',D:'5,730 years'}, correctAnswer:'D', difficulty:'hard', explanation:'Fun fact: Carbon-14 dating works because living things constantly exchange carbon with the environment. After death, C-14 decays at a known rate, allowing scientists to calculate age up to ~50,000 years.' },
    { text:'Which element has the highest melting point of all metals?', options:{A:'Iron',B:'Platinum',C:'Carbon',D:'Tungsten'}, correctAnswer:'D', difficulty:'hard', explanation:'Fun fact: Tungsten melts at 3,422°C — so it\'s used in light bulb filaments and rocket nozzles. Its name comes from the Swedish words for "heavy stone."' },
    { text:'What is the study of earthquakes called?', options:{A:'Meteorology',B:'Geology',C:'Vulcanology',D:'Seismology'}, correctAnswer:'D', difficulty:'medium', explanation:'Fun fact: Seismology detected that Earth has a solid inner core and a liquid outer core — information we gained entirely by studying earthquake waves, never by direct observation.' },
    { text:'Which vitamin does skin produce when exposed to sunlight?', options:{A:'Vitamin A',B:'Vitamin B',C:'Vitamin C',D:'Vitamin D'}, correctAnswer:'D', difficulty:'easy', explanation:'Fun fact: Vitamin D isn\'t really a vitamin — it\'s a hormone. Your skin produces it from cholesterol when exposed to UVB rays from the sun.' },
    { text:'What is the largest organ in the human body?', options:{A:'Liver',B:'Brain',C:'Lungs',D:'Skin'}, correctAnswer:'D', difficulty:'easy', explanation:'Fun fact: The skin of an average adult weighs about 3.6 kg and covers approximately 2 square metres. It completely replaces itself every 27 days.' },
    { text:'How many chromosomes do humans typically have?', options:{A:'44',B:'48',C:'52',D:'46'}, correctAnswer:'D', difficulty:'medium', explanation:'Fun fact: Humans have 23 pairs (46 total) of chromosomes. Chimpanzees have 24 pairs — oddly, two of their chromosomes fused at some point in our evolutionary past.' },
    { text:'What is the SI unit of electrical resistance?', options:{A:'Watt',B:'Ampere',C:'Volt',D:'Ohm'}, correctAnswer:'D', difficulty:'medium', explanation:'Fun fact: The ohm is named after Georg Simon Ohm, who formulated Ohm\'s Law in 1827. He initially faced ridicule from the scientific community, but was eventually vindicated.' },
    { text:'What particle has a negative electric charge?', options:{A:'Proton',B:'Neutron',C:'Positron',D:'Electron'}, correctAnswer:'D', difficulty:'easy', explanation:'Fun fact: Electrons are so small that if an atom were the size of a football stadium, the electron would be smaller than a grain of sand orbiting at the outer edge.' },
    { text:'What is the chemical formula for table salt?', options:{A:'KCl',B:'CaCO₃',C:'MgSO₄',D:'NaCl'}, correctAnswer:'D', difficulty:'medium', explanation:'Fun fact: NaCl (sodium chloride) is so essential to life that Roman soldiers were sometimes paid in salt — the origin of the word "salary."' },
    { text:'Which gas makes up the majority of Earth\'s atmosphere?', options:{A:'Oxygen',B:'Carbon dioxide',C:'Argon',D:'Nitrogen'}, correctAnswer:'D', difficulty:'easy', explanation:'Fun fact: Nitrogen makes up 78% of our atmosphere and is largely inert. Without nitrogen-fixing bacteria in the soil, plants couldn\'t grow and life as we know it wouldn\'t exist.' },
    { text:'What is the process by which plants make food using sunlight?', options:{A:'Respiration',B:'Fermentation',C:'Osmosis',D:'Photosynthesis'}, correctAnswer:'D', difficulty:'easy', explanation:'Fun fact: Photosynthesis produces all the oxygen in Earth\'s atmosphere. Before photosynthetic organisms evolved, Earth\'s air was mostly methane and carbon dioxide.' },
    { text:'At what temperature does water boil at sea level?', options:{A:'90°C',B:'95°C',C:'110°C',D:'100°C'}, correctAnswer:'D', difficulty:'easy', explanation:'Fun fact: Water boils at lower temperatures at high altitudes because atmospheric pressure is lower. On Mount Everest, water boils at just 70°C — too cool to make proper tea!' },
  ],
  history: [
    { text:'Who was the first president of the United States?', options:{A:'John Adams',B:'Thomas Jefferson',C:'Benjamin Franklin',D:'George Washington'}, correctAnswer:'D', difficulty:'easy', explanation:'Fun fact: George Washington was unanimously elected president twice and voluntarily stepped down after two terms, setting a precedent that lasted until FDR won four terms in the 1940s.' },
    { text:'In which year did World War I begin?', options:{A:'1912',B:'1913',C:'1915',D:'1914'}, correctAnswer:'D', difficulty:'easy', explanation:'Fun fact: WWI was triggered by the assassination of Archduke Franz Ferdinand on June 28, 1914, in Sarajevo — an event that set off a chain of alliances and declarations of war.' },
    { text:'Who was known as the "Iron Lady"?', options:{A:'Indira Gandhi',B:'Angela Merkel',C:'Golda Meir',D:'Margaret Thatcher'}, correctAnswer:'D', difficulty:'easy', explanation:'Fun fact: Margaret Thatcher earned the "Iron Lady" nickname from a Soviet newspaper in 1976. She became UK\'s first female Prime Minister in 1979 and served for 11 years.' },
    { text:'In which year did the Berlin Wall fall?', options:{A:'1987',B:'1988',C:'1990',D:'1989'}, correctAnswer:'D', difficulty:'medium', explanation:'Fun fact: The Berlin Wall fell on November 9, 1989, after a miscommunication led an East German spokesman to announce that borders were immediately open — sparking jubilant crowds to tear it down.' },
    { text:'Who sailed for Spain and reached the Americas in 1492?', options:{A:'Amerigo Vespucci',B:'Ferdinand Magellan',C:'Hernán Cortés',D:'Christopher Columbus'}, correctAnswer:'D', difficulty:'easy', explanation:'Fun fact: Columbus never knew he\'d reached the Americas — he died believing he\'d found Asia. The continents were named after Amerigo Vespucci, who first recognised they were a "New World."' },
    { text:'Which empire was ruled by Julius Caesar?', options:{A:'Greek',B:'Ottoman',C:'Byzantine',D:'Roman'}, correctAnswer:'D', difficulty:'easy', explanation:'Fun fact: Julius Caesar was never actually emperor — he was dictator. The first Roman Emperor was Augustus. Caesar\'s name became the root of "Kaiser" (German) and "Tsar" (Russian).' },
    { text:'In which city was the Titanic built?', options:{A:'London',B:'Southampton',C:'Liverpool',D:'Belfast'}, correctAnswer:'D', difficulty:'medium', explanation:'Fun fact: The Titanic was built at Harland and Wolff shipyard in Belfast, Northern Ireland. It took about 3,000 workers three years to build and was the largest ship of its time.' },
    { text:'What was the name of the first human-made satellite, launched in 1957?', options:{A:'Explorer 1',B:'Vostok',C:'Apollo',D:'Sputnik 1'}, correctAnswer:'D', difficulty:'medium', explanation:'Fun fact: Sputnik 1 was launched by the Soviet Union on October 4, 1957, triggering the Space Race. It was about the size of a beach ball and beeped radio signals back to Earth.' },
    { text:'Which treaty ended World War I?', options:{A:'Treaty of Paris',B:'Treaty of Vienna',C:'Treaty of Utrecht',D:'Treaty of Versailles'}, correctAnswer:'D', difficulty:'medium', explanation:'Fun fact: The Treaty of Versailles was signed on June 28, 1919 — exactly five years after the assassination that triggered the war. Its harsh terms are widely blamed for contributing to WWII.' },
    { text:'Who was the last Tsar of Russia?', options:{A:'Alexander III',B:'Nicholas I',C:'Alexander II',D:'Nicholas II'}, correctAnswer:'D', difficulty:'medium', explanation:'Fun fact: Nicholas II and his family were executed by the Bolsheviks in 1918. Their remains were not officially identified until DNA analysis was completed in the 1990s.' },
    { text:'Where was the ancient city of Carthage located?', options:{A:'Libya',B:'Algeria',C:'Morocco',D:'Tunisia'}, correctAnswer:'D', difficulty:'hard', explanation:'Fun fact: Carthage was Rome\'s greatest rival for control of the Mediterranean. After three Punic Wars, Rome finally destroyed it in 146 BC, famously salting the earth so nothing would grow.' },
    { text:'Who was the first woman to win a Nobel Prize?', options:{A:'Rosalind Franklin',B:'Dorothy Hodgkin',C:'Ada Lovelace',D:'Marie Curie'}, correctAnswer:'D', difficulty:'medium', explanation:'Fun fact: Marie Curie won Nobel Prizes in both Physics (1903) and Chemistry (1911) — the only person ever to win in two different scientific fields. Her notebooks are still radioactive today.' },
    { text:'What was Napoleon\'s famous final defeat called?', options:{A:'Battle of Trafalgar',B:'Battle of Austerlitz',C:'Battle of Leipzig',D:'Battle of Waterloo'}, correctAnswer:'D', difficulty:'easy', explanation:'Fun fact: The Battle of Waterloo on June 18, 1815 lasted only one day. Napoleon\'s defeat led to his exile to Saint Helena, where he died in 1821. "Waterloo" now means any crushing defeat.' },
    { text:'Which civilization built Machu Picchu?', options:{A:'Aztec',B:'Maya',C:'Olmec',D:'Inca'}, correctAnswer:'D', difficulty:'medium', explanation:'Fun fact: Machu Picchu was built around 1450 by the Inca emperor Pachacuti. The Spanish conquistadors never found it — it was only rediscovered by the outside world in 1911.' },
    { text:'In what year did the American Civil War begin?', options:{A:'1859',B:'1863',C:'1865',D:'1861'}, correctAnswer:'D', difficulty:'medium', explanation:'Fun fact: The Civil War began on April 12, 1861, when Confederate forces fired on Fort Sumter. It lasted four years and claimed more American lives than any other war.' },
    { text:'Who was the first person to walk on the Moon?', options:{A:'Buzz Aldrin',B:'Yuri Gagarin',C:'Alan Shepard',D:'Neil Armstrong'}, correctAnswer:'D', difficulty:'easy', explanation:'Fun fact: Neil Armstrong took his first steps on the Moon on July 21, 1969. His famous words "one small step for man, one giant leap for mankind" were heard by over 600 million people.' },
    { text:'Which pharaoh is believed to have ordered the construction of the Great Sphinx?', options:{A:'Ramesses II',B:'Tutankhamun',C:'Khufu',D:'Khafre'}, correctAnswer:'D', difficulty:'hard', explanation:'Fun fact: The Great Sphinx of Giza is believed to have been built around 2500 BC during the reign of Pharaoh Khafre. Its face may be modelled on his own features.' },
    { text:'In what year did India gain independence from Britain?', options:{A:'1945',B:'1946',C:'1948',D:'1947'}, correctAnswer:'D', difficulty:'medium', explanation:'Fun fact: India gained independence on August 15, 1947 — but the exact moment of midnight was chosen by an astrologer for its auspiciousness. Jawaharlal Nehru gave his famous "Tryst with Destiny" speech.' },
    { text:'What ancient wonder was located in Alexandria, Egypt?', options:{A:'Hanging Gardens',B:'Colossus of Rhodes',C:'Temple of Artemis',D:'Lighthouse of Alexandria'}, correctAnswer:'D', difficulty:'medium', explanation:'Fun fact: The Lighthouse of Alexandria (Pharos) stood about 100 metres tall and was visible 50 km out to sea. It stood for over 1,000 years before being destroyed by earthquakes.' },
    { text:'Which empire was the largest in human history by land area?', options:{A:'Roman Empire',B:'Mongol Empire',C:'Ottoman Empire',D:'British Empire'}, correctAnswer:'D', difficulty:'hard', explanation:'Fun fact: At its peak in 1920, the British Empire covered 24% of Earth\'s total land area and governed 412 million people — about 23% of the world\'s population at the time.' },
  ],

  telugu: [
    // 2024 releases
    { text:'Which 2024 sci-fi Telugu film starred Prabhas as Kalki?', options:{A:'Salaar',B:'Kalki 2898 AD',C:'Spirit',D:'Raja Saab'}, correctAnswer:'B', difficulty:'easy', explanation:'Fun fact: Kalki 2898 AD (2024) directed by Nag Ashwin is a mythological sci-fi epic set in the future Kalki avatar story, featuring Prabhas, Deepika Padukone, and Amitabh Bachchan. It grossed over ₹1,000 crore worldwide.' },
    { text:'Who directed Kalki 2898 AD (2024)?', options:{A:'SS Rajamouli',B:'Trivikram',C:'Nag Ashwin',D:'Sukumar'}, correctAnswer:'C', difficulty:'medium', explanation:'Fun fact: Nag Ashwin, who also directed "Mahanati" (2018), created Kalki 2898 AD as a pan-India mythological sci-fi spectacle, one of the most expensive Indian films ever made.' },
    { text:'Which actress plays Deepa in Kalki 2898 AD (2024)?', options:{A:'Rashmika Mandanna',B:'Pooja Hegde',C:'Samantha',D:'Deepika Padukone'}, correctAnswer:'D', difficulty:'easy', explanation:'Fun fact: Deepika Padukone made her Telugu film debut in Kalki 2898 AD, playing a pregnant woman named Deepa who carries the future saviour. The film was her first proper south Indian project.' },
    { text:'Pushpa 2: The Rule (2024) — who plays the main antagonist SP Shekhawat?', options:{A:'Rao Ramesh',B:'Fahadh Faasil',C:'Sunil',D:'Jagapathi Babu'}, correctAnswer:'B', difficulty:'medium', explanation:'Fun fact: Malayalam superstar Fahadh Faasil reprised his role as the fierce SP Bhanwar Singh Shekhawat in Pushpa 2, and his performance was widely acclaimed as one of the highlights of the film.' },
    { text:'Which superstar\'s film "Pushpa 2: The Rule" broke all Indian box office records in 2024?', options:{A:'Prabhas',B:'Mahesh Babu',C:'Allu Arjun',D:'Ram Charan'}, correctAnswer:'C', difficulty:'easy', explanation:'Fun fact: Pushpa 2: The Rule (2024) became the highest-grossing Indian film of all time, crossing ₹1,800 crore in its first week, surpassing even Baahubali 2\'s records.' },
    { text:'Which 2024 film starred Teja Sajja as Lord Hanuman?', options:{A:'Adipurush',B:'HanuMan',C:'Bro',D:'Skanda'}, correctAnswer:'B', difficulty:'easy', explanation:'Fun fact: HanuMan (2024) directed by Prashanth Varma became a massive blockbuster and is credited with starting the "Prashanth Varma Cinematic Universe" (PVCU), with a sequel Jai Hanuman announced.' },
    { text:'Who played the villain in the 2024 superhero film HanuMan?', options:{A:'Vinay Rai',B:'Nawab Shah',C:'Varalaxmi Sarathkumar',D:'Sudheer Babu'}, correctAnswer:'A', difficulty:'hard', explanation:'Fun fact: Vinay Rai played the power-hungry villain Meenakshi Nath in HanuMan, seeking the divine Mace (Gada) of Hanuman for his own ambitions. His performance was widely praised.' },
    { text:'Which 2024 Telugu film starred Jr NTR and was directed by Koratala Siva?', options:{A:'Devara',B:'NTR31',C:'Jai Lava Kusa 2',D:'Aravindha Sametha 2'}, correctAnswer:'A', difficulty:'easy', explanation:'Fun fact: Devara: Part 1 (2024) is a pan-India action thriller where Jr NTR plays a dual role — a fearsome dacoit and his timid son. Janhvi Kapoor made her Telugu debut in this film.' },
    { text:'In Devara (2024), who plays the main antagonist Bhaira?', options:{A:'Rana Daggubati',B:'Saif Ali Khan',C:'Jagapathi Babu',D:'Sonu Sood'}, correctAnswer:'B', difficulty:'medium', explanation:'Fun fact: Bollywood star Saif Ali Khan plays the terrifying villain Bhaira in Devara, marking his significant Telugu film role. His menacing screen presence was one of the most talked-about aspects of the film.' },
    { text:'Which 2023 film starred Prabhas as a deadly assassin called "Salaar"?', options:{A:'Adipurush',B:'Salaar: Part 1 – Ceasefire',C:'Radhe Shyam',D:'Project K'}, correctAnswer:'B', difficulty:'easy', explanation:'Fun fact: Salaar: Part 1 – Ceasefire (2023) directed by Prashanth Neel (of KGF fame) became one of the biggest hits of 2023. Prabhas plays a ruthless gangster, and the film has a sequel in the works.' },
    // 2023 releases
    { text:'Which 2023 Telugu film starred Ram Charan and had a political storyline?', options:{A:'Acharya',B:'Magadheera 2',C:'RC15 / Game Changer',D:'Rangasthalam 2'}, correctAnswer:'C', difficulty:'medium', explanation:'Fun fact: Game Changer (2025) directed by Shankar starred Ram Charan as an IAS officer fighting political corruption. It was one of the most awaited pan-India films.' },
    { text:'Which actress won the Filmfare Best Actress (Telugu) award for Dasara (2023)?', options:{A:'Pooja Hegde',B:'Keerthi Suresh',C:'Keerthy Suresh',D:'Nithya Menen'}, correctAnswer:'C', difficulty:'hard', explanation:'Fun fact: Keerthy Suresh won Best Actress for her powerful performance in Dasara (2023), where she played an alcoholic woman in a coal-mining town setting opposite Nani.' },
    { text:'Who plays the lead in the 2023 Telugu blockbuster "Dasara"?', options:{A:'Vijay Deverakonda',B:'Nani',C:'Adivi Sesh',D:'Naveen Polishetty'}, correctAnswer:'B', difficulty:'easy', explanation:'Fun fact: Nani plays Dharani, a coal mine worker who becomes entangled in power and violence, in Dasara (2023). It was Nani\'s first mass action film, a big departure from his usual roles.' },
    { text:'Which 2023 Telugu film starred Vijay Deverakonda as a soldier?', options:{A:'Kushi',B:'Jana Gana Mana',C:'Family Star',D:'VD12'}, correctAnswer:'A', difficulty:'medium', explanation:'Fun fact: Kushi (2023) is a romantic entertainer directed by Shiva Nirvana, starring Vijay Deverakonda and Samantha Ruth Prabhu. The film also features a blockbuster title track.' },
    { text:'Who directed Pushpa 2: The Rule (2024)?', options:{A:'Trivikram',B:'Harish Shankar',C:'Sukumar',D:'Boyapati Srinu'}, correctAnswer:'C', difficulty:'easy', explanation:'Fun fact: Sukumar, known for his unique storytelling style, directed both Pushpa: The Rise and Pushpa 2: The Rule. He is also known for films like Arya, 100% Love, and 1: Nenokkadine.' },
    { text:'Which iconic song from Pushpa 2 became a massive 2024 global hit?', options:{A:'Saami Saami',B:'Oo Antava',C:'Kissik',D:'Sooseki'}, correctAnswer:'C', difficulty:'easy', explanation:'Fun fact: "Kissik" from Pushpa 2 featuring Allu Arjun and Sreeleela became a massive chartbuster in 2024. Sreeleela\'s electrifying dance moves in the song went viral worldwide.' },
    { text:'Which actress plays Srivalli in both Pushpa films?', options:{A:'Pooja Hegde',B:'Rashmika Mandanna',C:'Nayanthara',D:'Tamanna Bhatia'}, correctAnswer:'B', difficulty:'easy', explanation:'Fun fact: Rashmika Mandanna plays Srivalli, Pushpa\'s love interest, in both films. She is also known as the "National Crush of India" and has starred in several Bollywood films including Animal.' },
    { text:'In Kalki 2898 AD, which legendary actor plays Ashwatthama?', options:{A:'Mohanlal',B:'Chiranjeevi',C:'Amitabh Bachchan',D:'Kamal Haasan'}, correctAnswer:'C', difficulty:'easy', explanation:'Fun fact: Amitabh Bachchan plays the immortal warrior Ashwatthama in Kalki 2898 AD, a character from the Mahabharata who was cursed to live forever. His portrayal was widely praised.' },
    { text:'Which 2024 Telugu film starred Venkatesh and Naga Chaitanya?', options:{A:'Bhagavanth Kesari',B:'Custody',C:'Saindhav',D:'Chor Bazaari'}, correctAnswer:'A', difficulty:'medium', explanation:'Fun fact: Bhagavanth Kesari (2023) starred Nandamuri Balakrishna and Sreeleela, not Venkatesh and Naga Chaitanya. The 2024 hit featuring both was Venky Mama\'s sequel.' },
    { text:'Which dancer\'s performance in "Kissik" (Pushpa 2) went massively viral in 2024?', options:{A:'Tamanna Bhatia',B:'Pooja Hegde',C:'Sreeleela',D:'Rashmika Mandanna'}, correctAnswer:'C', difficulty:'easy', explanation:'Fun fact: Sreeleela, known as Tollywood\'s top dance sensation, delivered a jaw-dropping performance in "Kissik" that trended globally. She is considered one of the best dancers in current Telugu cinema.' },
  ],
};

function getLocalQuestions(room) {
  const { topic, difficulty, totalRounds } = room.settings;
  const pool = (LOCAL_QUESTIONS[topic] || LOCAL_QUESTIONS.general).filter(q => {
    const h = hashQ(q.text);
    if (room.usedQuestions.has(h)) return false;
    room.usedQuestions.add(h);
    return true;
  });

  // Prefer questions matching the chosen difficulty, then fill with others
  const preferred = pool.filter(q => q.difficulty === difficulty);
  const others    = pool.filter(q => q.difficulty !== difficulty);
  const ordered   = [...preferred, ...others];

  if (ordered.length < totalRounds)
    throw new Error(`Not enough questions in the bank for this topic/difficulty combination.`);

  // Fisher-Yates shuffle then slice
  for (let i = ordered.length - 1; i > 0; i--) {
    const j = Math.random() * (i + 1) | 0;
    [ordered[i], ordered[j]] = [ordered[j], ordered[i]];
  }
  return ordered
    .slice(0, totalRounds)
    .map(q => shuffleOpts({ ...q, id: crypto.randomUUID() }));
}

function getLocalRoasts(players) {
  const templates = [
    p => `${p.name} answered with the confidence of someone who definitely Googled this beforehand.`,
    p => `${p.name} scored ${p.score} points — which is ${p.score} more than their study effort suggested.`,
    p => `${p.name} got ${p.scoreHistory.filter(h=>h.correct).length} right. ${p.scoreHistory.filter(h=>h.correct).length === 0 ? 'Even a broken clock is right twice a day, yet here we are.' : 'Not bad for someone who clearly learned everything from movie trailers.'}`,
    p => `${p.name} played like they were saving their brain cells for something more important. Respect.`,
    p => `${p.name} finished with ${p.score} points. Their parents are *choosing* to be proud.`,
  ];
  return players.map((p, i) => ({ name: p.name, roast: templates[i % templates.length](p) }));
}

function hashQ(text) {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = (((h << 5) + h) + text.charCodeAt(i)) & 0xffffffff;
  return (h >>> 0).toString(36);
}

function shuffleOpts(q) {
  const entries = Object.entries(q.options);
  for (let i = entries.length - 1; i > 0; i--) {
    const j = Math.random() * (i + 1) | 0;
    [entries[i], entries[j]] = [entries[j], entries[i]];
  }
  const correctVal = q.options[q.correctAnswer];
  const opts = {}, keys = ['A','B','C','D'];
  let correctAnswer = q.correctAnswer;
  entries.forEach(([, v], idx) => {
    opts[keys[idx]] = v;
    if (v === correctVal) correctAnswer = keys[idx];
  });
  return { ...q, options: opts, correctAnswer };
}

async function generateQuestions(room) {
  if (!API_KEY && !GROK_KEY) return getLocalQuestions(room);
  try { return await _generateQuestionsAI(room); }
  catch (e) { console.warn('AI question generation failed, using local bank:', e.message); return getLocalQuestions(room); }
}
async function _generateQuestionsAI(room) {
  const { topic, customTopic, difficulty, totalRounds } = room.settings;
  const n = totalRounds + 3;
  const displayTopic = topic === 'custom' ? customTopic : topic;

  const system = `You are a trivia question generator for a fun multiplayer party game.
Generate exactly ${n} unique multiple-choice trivia questions about "${displayTopic}".
Difficulty: ${difficulty} (easy=well-known facts, medium=some knowledge, hard=expert level).
Rules:
- All 4 options must be plausible — no obviously wrong answers
- Exactly one correct answer per question
- Keep question text under 140 characters
- Vary styles: "Which...", "Who...", "What...", "In what year...", "How many..."
- Explanations: 2-3 sentences starting with "Fun fact:" or "Did you know..."
- Return ONLY valid JSON, no markdown`;

  const user = `Generate ${n} trivia questions about "${displayTopic}" at ${difficulty} difficulty.
Return this exact JSON:
{"questions":[{"id":"q1","text":"...","options":{"A":"...","B":"...","C":"...","D":"..."},"correctAnswer":"A","explanation":"Fun fact: ..."}]}`;

  const data = await callClaude(system, user, 4096);
  if (!Array.isArray(data?.questions)) throw new Error('Invalid format from Claude');

  const valid = data.questions
    .filter(q => q.text && q.options && q.correctAnswer && q.explanation)
    .filter(q => {
      const h = hashQ(q.text);
      if (room.usedQuestions.has(h)) return false;
      room.usedQuestions.add(h);
      return true;
    })
    .map(q => shuffleOpts({ ...q, id: q.id || crypto.randomUUID() }))
    .slice(0, totalRounds);

  if (valid.length < totalRounds)
    throw new Error(`Only got ${valid.length} valid questions, need ${totalRounds}`);
  return valid;
}

async function generateRoasts(players, settings) {
  if (!API_KEY && !GROK_KEY) return getLocalRoasts(players);
  try { return await _generateRoastsAI(players, settings); }
  catch (e) { return getLocalRoasts(players); }
}
async function _generateRoastsAI(players, settings) {
  const topic = settings.topic === 'custom' ? settings.customTopic : settings.topic;
  const standings = players.map((p, i) =>
    `${i+1}. ${p.name}: ${p.score} pts, ${p.scoreHistory.filter(h=>h.correct).length}/${p.scoreHistory.length} correct`
  ).join('\n');

  const system = `You are a witty, friendly roast comedian for a trivia party game.
Roasts must be light and funny — never mean. 1-2 punchy sentences per player.
Return ONLY valid JSON, no markdown.`;
  const user = `Game: ${topic} | ${settings.difficulty} | ${settings.totalRounds} rounds\n${standings}\nReturn: {"roasts":[{"name":"...","roast":"..."}]}`;

  try {
    const data = await callClaude(system, user, 1024);
    if (!Array.isArray(data?.roasts)) throw new Error('bad format');
    return data.roasts;
  } catch {
    const fallbacks = ["Showed up, which honestly counts!", "Kept everyone guessing — including themselves.",
      "Really committed to the 'learning experience'.", "Proof enthusiasm ≠ knowledge.", "A true wildcard!"];
    return players.map((p, i) => ({ name: p.name, roast: fallbacks[i % fallbacks.length] }));
  }
}

// ── Game Engine ───────────────────────────────────────────────────────────────
const Q_MS  = 15000;
const REV_MS = 8000;
const LB_MS  = 5000;

async function startGame(room) {
  clearRoomTimers(room); // defensive clear before starting
  room.phase = 'loading';
  broadcast(room.code, 'game:loading', {});

  try {
    room.questions = await generateQuestions(room);
    room.currentQuestionIndex = 0;
    for (const p of room.players.values()) { p.score = 0; p.scoreHistory = []; }
    startQuestion(room);
  } catch (err) {
    console.error('Question generation failed:', err.message);
    room.phase = 'lobby';
    broadcast(room.code, 'room:error', { message: 'Failed to generate questions. Please try again.' });
  }
}

function startQuestion(room) {
  room.phase = 'question';
  room.answersReceived = new Map();
  room.questionDeadline = Date.now() + Q_MS;

  const { correctAnswer, explanation, ...clientQ } = room.questions[room.currentQuestionIndex];

  broadcast(room.code, 'game:question', {
    question: clientQ,
    questionNumber: room.currentQuestionIndex + 1,
    totalQuestions: room.settings.totalRounds,
    deadline: room.questionDeadline,
  });

  room.timerHandle = setTimeout(() => revealAnswer(room), Q_MS + 200);
}

function handleAnswer(room, clientId, questionId, selectedOption) {
  const q = room.questions[room.currentQuestionIndex];
  if (!q || q.id !== questionId || room.answersReceived.has(clientId) || room.phase !== 'question') return;

  const submittedAt = Date.now();
  room.answersReceived.set(clientId, {
    selectedOption,
    timeRemaining: Math.max(0, (room.questionDeadline - submittedAt) / 1000),
  });

  const all = connected(room);
  if (room.answersReceived.size >= all.length) {
    clearTimeout(room.timerHandle);
    setTimeout(() => revealAnswer(room), 500);
  }
}

function revealAnswer(room) {
  if (room.phase !== 'question') return;
  room.phase = 'reveal';
  clearTimeout(room.timerHandle);

  const q = room.questions[room.currentQuestionIndex];
  const results = [];

  for (const [cid, ans] of room.answersReceived) {
    const isCorrect = ans.selectedOption === q.correctAnswer;
    const { speedBonus, total } = calcPoints(isCorrect, ans.timeRemaining);
    const player = room.players.get(cid);
    if (player) {
      player.score += total;
      player.scoreHistory.push({ round: room.currentQuestionIndex + 1, points: total, speedBonus, correct: isCorrect });
    }
    results.push({ clientId: cid, selectedOption: ans.selectedOption, pointsEarned: total, speedBonus, correct: isCorrect });
  }

  for (const p of room.players.values()) {
    if (!room.answersReceived.has(p.clientId)) {
      p.scoreHistory.push({ round: room.currentQuestionIndex + 1, points: 0, speedBonus: 0, correct: false });
      results.push({ clientId: p.clientId, selectedOption: null, pointsEarned: 0, speedBonus: 0, correct: false });
    }
  }

  const leaderboard = ranked(room); // computed once, reused below
  const isFinal = room.currentQuestionIndex >= room.settings.totalRounds - 1;

  broadcast(room.code, 'game:reveal', { correctAnswer: q.correctAnswer, explanation: q.explanation, results, leaderboard });

  room.revealHandle = setTimeout(() => {
    if (room.phase === 'reveal') showLeaderboard(room, isFinal);
  }, REV_MS);
}

function showLeaderboard(room, isFinal) {
  clearTimeout(room.revealHandle);
  room.phase = 'leaderboard';

  broadcast(room.code, 'game:leaderboard', {
    rankedPlayers: ranked(room),
    questionNumber: room.currentQuestionIndex + 1,
    totalQuestions: room.settings.totalRounds,
    isFinal,
  });

  room.leaderboardHandle = setTimeout(() => {
    if (room.phase !== 'leaderboard') return;
    if (isFinal) endGame(room);
    else nextQuestion(room);
  }, LB_MS);
}

function nextQuestion(room) {
  clearTimeout(room.leaderboardHandle);
  room.currentQuestionIndex++;
  if (room.currentQuestionIndex >= room.settings.totalRounds) endGame(room);
  else startQuestion(room);
}

async function endGame(room) {
  clearTimeout(room.leaderboardHandle);
  room.phase = 'final';
  const rankedPlayers = ranked(room);
  const roasts = await generateRoasts(rankedPlayers, room.settings);
  broadcast(room.code, 'game:final', { rankedPlayers, roasts, winner: rankedPlayers[0] });
  room.cleanupHandle = setTimeout(() => deleteRoom(room.code), 30 * 60 * 1000);
}

function resetRoom(room) {
  clearRoomTimers(room);
  room.phase = 'lobby';
  room.questions = [];
  room.currentQuestionIndex = 0;
  room.questionDeadline = null;
  room.answersReceived = new Map();
  for (const p of room.players.values()) { p.score = 0; p.scoreHistory = []; }
}

// ── HTTP Utilities ────────────────────────────────────────────────────────────
function readBody(req) {
  return new Promise((res, rej) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => { try { res(JSON.parse(body || '{}')); } catch { res({}); } });
    req.on('error', rej);
  });
}

function json(res, status, data) {
  const s = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(s);
}

function roomState(room) {
  return { players: playerList(room), settings: room.settings, hostClientId: room.hostClientId };
}

// ── HTTP Server ───────────────────────────────────────────────────────────────
const INDEX  = path.join(__dirname, 'public', 'index.html');
const PUBLIC = path.join(__dirname, 'public');
const MIME   = { '.html':'text/html', '.js':'application/javascript', '.mjs':'application/javascript', '.css':'text/css', '.json':'application/json', '.ico':'image/x-icon' };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const { pathname } = url;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST', 'Access-Control-Allow-Headers': 'Content-Type' });
    return res.end();
  }

  // ── SSE ──────────────────────────────────────────────────────────────────
  if (pathname === '/events') {
    const clientId = url.searchParams.get('clientId');
    const roomCode = url.searchParams.get('roomCode');
    if (!clientId) return json(res, 400, { error: 'clientId required' });

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
      'X-Accel-Buffering': 'no',
    });

    clients.set(clientId, { res, roomCode: roomCode || null });
    res.write(`event: connected\ndata: {"clientId":"${clientId}"}\n\n`);

    const hb = setInterval(() => res.writableEnded ? clearInterval(hb) : res.write(':hb\n\n'), 15000);
    req.on('close', () => { clearInterval(hb); clients.delete(clientId); onDisconnect(clientId); });
    return;
  }

  // ── API ───────────────────────────────────────────────────────────────────
  if (pathname.startsWith('/api/')) {
    if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
    const body = await readBody(req);

    try {
      // Create room
      if (pathname === '/api/room/create') {
        const { playerName, clientId, settings } = body;
        if (!playerName?.trim() || !clientId) return json(res, 400, { error: 'playerName and clientId required' });
        const room = createRoom(clientId, playerName.trim(), settings);
        const conn = clients.get(clientId);
        if (conn) conn.roomCode = room.code;
        const p = room.players.get(clientId);
        sendTo(clientId, 'room:created', { roomCode: room.code, player: { clientId, name: p.name, avatar: p.avatar }, ...roomState(room) });
        return json(res, 200, { ok: true });
      }

      // Join room
      if (pathname === '/api/room/join') {
        const { playerName, clientId, roomCode } = body;
        const code = roomCode?.trim().toUpperCase();
        if (!playerName?.trim() || !clientId || !code) return json(res, 400, { error: 'Missing fields' });
        const room = rooms.get(code);
        if (!room) return json(res, 404, { error: `Room "${code}" not found` });
        if (room.phase !== 'lobby') return json(res, 400, { error: 'Game already in progress' });
        if (room.players.size >= 10) return json(res, 400, { error: 'Room is full' });

        const name = playerName.trim();
        const existing = [...room.players.values()].find(p => p.name.toLowerCase() === name.toLowerCase() && !p.isConnected);
        if (existing) {
          const wasHost = room.hostClientId === existing.clientId;
          room.players.delete(existing.clientId);
          existing.clientId = clientId;
          existing.isConnected = true;
          room.players.set(clientId, existing);
          if (wasHost) room.hostClientId = clientId;
        } else {
          addPlayer(room, clientId, name);
        }

        const conn = clients.get(clientId);
        if (conn) conn.roomCode = code;
        const p = room.players.get(clientId);
        sendTo(clientId, 'room:joined', {
          roomCode: code,
          player: { clientId, name: p.name, avatar: p.avatar },
          isHost: room.hostClientId === clientId,
          ...roomState(room),
        });
        for (const [id] of clients) {
          if (id !== clientId && clients.get(id)?.roomCode === code)
            sendTo(id, 'room:updated', roomState(room));
        }
        return json(res, 200, { ok: true });
      }

      // Update settings
      if (pathname === '/api/settings/update') {
        const { roomCode, clientId, settings } = body;
        const room = rooms.get(roomCode);
        if (!room || room.hostClientId !== clientId) return json(res, 403, { error: 'Not the host' });
        Object.assign(room.settings, settings);
        broadcast(roomCode, 'room:updated', roomState(room));
        return json(res, 200, { ok: true });
      }

      // Start game
      if (pathname === '/api/game/start') {
        const { roomCode, clientId } = body;
        const room = rooms.get(roomCode);
        if (!room) return json(res, 404, { error: 'Room not found' });
        if (room.hostClientId !== clientId) return json(res, 403, { error: 'Not the host' });
        if (room.phase !== 'lobby') return json(res, 400, { error: 'Already started' });
        startGame(room); // fire-and-forget
        return json(res, 200, { ok: true });
      }

      // Submit answer
      if (pathname === '/api/game/answer') {
        const { roomCode, clientId, questionId, selectedOption } = body;
        const room = rooms.get(roomCode);
        if (room) handleAnswer(room, clientId, questionId, selectedOption);
        return json(res, 200, { ok: true });
      }

      // Host advances
      if (pathname === '/api/game/next') {
        const { roomCode, clientId } = body;
        const room = rooms.get(roomCode);
        if (!room || room.hostClientId !== clientId) return json(res, 403, { error: 'Not the host' });
        const isFinal = room.currentQuestionIndex >= room.settings.totalRounds - 1;
        if (room.phase === 'reveal') { clearTimeout(room.revealHandle); showLeaderboard(room, isFinal); }
        else if (room.phase === 'leaderboard') { clearTimeout(room.leaderboardHandle); if (isFinal) endGame(room); else nextQuestion(room); }
        return json(res, 200, { ok: true });
      }

      // Restart
      if (pathname === '/api/game/restart') {
        const { roomCode, clientId } = body;
        const room = rooms.get(roomCode);
        if (!room || room.hostClientId !== clientId) return json(res, 403, { error: 'Not the host' });
        resetRoom(room);
        broadcast(roomCode, 'room:updated', { ...roomState(room), phase: 'lobby' });
        return json(res, 200, { ok: true });
      }

      json(res, 404, { error: 'Unknown endpoint' });
    } catch (err) {
      console.error('API error:', err);
      json(res, 500, { error: 'Server error' });
    }
    return;
  }

  // ── Static ────────────────────────────────────────────────────────────────
  const rel      = decodeURIComponent(pathname).replace(/^\/+/, '') || 'index.html';
  const filePath = path.resolve(PUBLIC, rel);
  if (!filePath.startsWith(PUBLIC + path.sep) && filePath !== INDEX) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  try {
    const data = fs.readFileSync(filePath);
    const ext  = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  } catch { res.writeHead(404); res.end('Not found'); }
  return;
});

// ── Disconnect ────────────────────────────────────────────────────────────────
function onDisconnect(clientId) {
  const room = findRoom(clientId);
  if (!room) return;

  const player = room.players.get(clientId);
  if (!player) return;
  player.isConnected = false;

  if (room.hostClientId === clientId) {
    const next = connected(room)[0];
    if (next) room.hostClientId = next.clientId;
    else {
      room.cleanupHandle = setTimeout(() => deleteRoom(room.code), 60000);
      return;
    }
  }

  broadcast(room.code, 'room:updated', roomState(room));

  if (room.phase === 'question') {
    const all = connected(room);
    if (all.length > 0 && room.answersReceived.size >= all.length) {
      clearTimeout(room.timerHandle);
      setTimeout(() => revealAnswer(room), 500);
    }
  }
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🎮  Trivia Blitz  →  http://localhost:${PORT}\n`);
  if (USE_GROK) console.log('🤖  Using Groq AI (Llama 3.3) for questions\n');
  else if (!API_KEY) console.warn('⚠   No AI key set — using local question bank\n');
});
