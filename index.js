// ═══════════════════════════════════════════════════════════════
//  Discord Music Bot — все в одному файлі
//  Команди реєструються автоматично при запуску
// ═══════════════════════════════════════════════════════════════

require('dotenv').config();

const {
  Client, GatewayIntentBits, Partials, Collection, ActivityType,
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ModalBuilder, TextInputBuilder, TextInputStyle,
  StringSelectMenuBuilder, StringSelectMenuOptionBuilder,
  REST, Routes, PermissionFlagsBits, ChannelType,
} = require('discord.js');

const {
  joinVoiceChannel, createAudioPlayer, createAudioResource,
  AudioPlayerStatus, VoiceConnectionStatus, entersState,
  NoSubscriberBehavior,
} = require('@discordjs/voice');

const playdl = require('play-dl');

// ───────────────────────────────────────────────
// SLASH КОМАНДИ (реєструються автоматично)
// ───────────────────────────────────────────────
const COMMANDS = [
  { name: 'panel', description: '🎵 Відкрити панель керування музикою' },
  {
    name: 'play', description: '▶️ Грати музику (YouTube / Spotify / SoundCloud)',
    options: [{ name: 'query', description: 'Назва або посилання', type: 3, required: true }],
  },
  { name: 'skip',      description: '⏭️ Пропустити поточний трек' },
  { name: 'stop',      description: '⏹️ Зупинити музику та очистити чергу' },
  { name: 'pause',     description: '⏸️ Пауза / Продовжити' },
  { name: 'queue',     description: '📋 Показати чергу треків' },
  { name: 'shuffle',   description: '🔀 Перемішати чергу' },
  { name: 'loop',      description: '🔁 Режим повтору (вимк → трек → черга)' },
  { name: 'nowplaying',description: '🎵 Інформація про поточний трек' },
  {
    name: 'volume', description: '🔊 Встановити гучність (0–100)',
    options: [{ name: 'level', description: 'Гучність 0-100', type: 4, required: true, min_value: 0, max_value: 100 }],
  },
  {
    name: 'remove', description: '🗑️ Видалити трек з черги',
    options: [{ name: 'position', description: 'Позиція в черзі', type: 4, required: true, min_value: 1 }],
  },
  {
    name: 'clear', description: '🧹 Очистити повідомлення в каналі',
    options: [
      { name: 'amount',  description: 'Кількість (1–100)', type: 4, required: true, min_value: 1, max_value: 100 },
      { name: 'channel', description: 'Канал (за замовч. — поточний)', type: 7, required: false },
    ],
  },
];

// ───────────────────────────────────────────────
// АВТО-РЕЄСТРАЦІЯ КОМАНД
// ───────────────────────────────────────────────
async function deployCommands() {
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  try {
    console.log('🔄 Реєстрація slash-команд...');
    if (process.env.GUILD_ID) {
      await rest.put(
        Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
        { body: COMMANDS }
      );
      console.log('✅ Команди зареєстровані (сервер)');
    } else {
      await rest.put(
        Routes.applicationCommands(process.env.CLIENT_ID),
        { body: COMMANDS }
      );
      console.log('✅ Команди зареєстровані глобально (до 1 год)');
    }
  } catch (err) {
    console.error('❌ Помилка реєстрації команд:', err.message);
  }
}

// ───────────────────────────────────────────────
// ІНІЦІАЛІЗАЦІЯ PLAY-DL
// ───────────────────────────────────────────────
async function initPlayDL() {
  try {
    if (process.env.YOUTUBE_COOKIE) {
      await playdl.setToken({ youtube: { cookie: process.env.YOUTUBE_COOKIE } });
    }
    if (process.env.SPOTIFY_CLIENT_ID && process.env.SPOTIFY_CLIENT_SECRET) {
      await playdl.setToken({
        spotify: {
          client_id: process.env.SPOTIFY_CLIENT_ID,
          client_secret: process.env.SPOTIFY_CLIENT_SECRET,
          refresh_token: process.env.SPOTIFY_REFRESH_TOKEN || '',
          market: 'UA',
        },
      });
    }
    console.log('✅ play-dl ініціалізовано');
  } catch (e) {
    console.warn('⚠️ play-dl ініціалізація (часткова):', e.message);
  }
}

// ───────────────────────────────────────────────
// ДОПОМІЖНІ ФУНКЦІЇ
// ───────────────────────────────────────────────
function formatDuration(sec) {
  if (!sec) return '∞';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`
    : `${m}:${String(s).padStart(2,'0')}`;
}

function srcEmoji(src) {
  return { youtube: '🔴', spotify: '🟢', soundcloud: '🟠' }[src] || '🎵';
}

function loopLabel(loop) {
  return { none: 'Вимк', track: '🔂 Трек', queue: '🔁 Черга' }[loop] || 'Вимк';
}

function makeQueue(guildId) {
  return {
    guildId, tracks: [], currentTrack: null,
    player: null, connection: null,
    volume: 80, loop: 'none',
    textChannel: null, voiceChannel: null,
    panelMessage: null, panelChannelId: null,
  };
}

// ───────────────────────────────────────────────
// ПОШУК ТРЕКУ
// ───────────────────────────────────────────────
async function searchTrack(query) {
  try {
    const type = await playdl.validate(query);

    if (type === 'yt_video') {
      const info = await playdl.video_info(query);
      const v = info.video_details;
      return [{ title: v.title, url: v.url, duration: v.durationInSec, thumbnail: v.thumbnails?.[0]?.url || '', source: 'youtube' }];
    }

    if (type === 'yt_playlist') {
      const pl = await playdl.playlist_info(query, { incomplete: true });
      const vids = await pl.all_videos();
      return vids.slice(0, 50).map(v => ({ title: v.title, url: v.url, duration: v.durationInSec, thumbnail: v.thumbnails?.[0]?.url || '', source: 'youtube' }));
    }

    if (type === 'sp_track' || type === 'sp_album' || type === 'sp_playlist') {
      const sp = await playdl.spotify(query);
      const tracks = sp.type === 'track' ? [sp] : await sp.all_tracks();
      const result = [];
      for (const t of tracks.slice(0, 25)) {
        const name = `${t.artists?.[0]?.name || ''} ${t.name}`.trim();
        const yt = await playdl.search(name, { limit: 1 });
        if (yt[0]) result.push({ title: t.name, url: yt[0].url, duration: Math.floor((t.durationInMs || 0) / 1000), thumbnail: t.thumbnail?.url || yt[0].thumbnails?.[0]?.url || '', source: 'spotify' });
      }
      return result;
    }

    if (type === 'so_track' || type === 'so_playlist') {
      const so = await playdl.soundcloud(query);
      if (so.type === 'track') return [{ title: so.name, url: so.url, duration: Math.floor(so.durationInMs / 1000), thumbnail: so.thumbnail || '', source: 'soundcloud' }];
      const trs = await so.all_tracks();
      return trs.slice(0, 25).map(t => ({ title: t.name, url: t.url, duration: Math.floor(t.durationInMs / 1000), thumbnail: t.thumbnail || '', source: 'soundcloud' }));
    }

    // Текстовий пошук
    const res = await playdl.search(query, { limit: 5 });
    return res.map(v => ({ title: v.title, url: v.url, duration: v.durationInSec, thumbnail: v.thumbnails?.[0]?.url || '', source: 'youtube' }));
  } catch (e) {
    console.error('searchTrack error:', e.message);
    return [];
  }
}

// ───────────────────────────────────────────────
// ОТРИМАННЯ АУДІО СТРІМУ (з обходом обмежень)
// ───────────────────────────────────────────────
async function getStream(track) {
  // Спроба 1: пряме стрімання
  try {
    const stream = await playdl.stream(track.url, { quality: 2, discordPlayerCompatibility: true });
    return createAudioResource(stream.stream, { inputType: stream.type, inlineVolume: true });
  } catch (e1) {
    console.warn('getStream attempt 1 failed:', e1.message);
  }

  // Спроба 2: оновлюємо URL через video_info і пробуємо знову
  try {
    const info = await playdl.video_info(track.url);
    const freshUrl = info.video_details.url;
    const stream = await playdl.stream(freshUrl, { quality: 2, discordPlayerCompatibility: true });
    return createAudioResource(stream.stream, { inputType: stream.type, inlineVolume: true });
  } catch (e2) {
    console.warn('getStream attempt 2 failed:', e2.message);
  }

  // Спроба 3: шукаємо альтернативу за назвою
  try {
    const alt = await playdl.search(track.title, { limit: 1 });
    if (alt[0]) {
      const stream = await playdl.stream(alt[0].url, { quality: 2, discordPlayerCompatibility: true });
      return createAudioResource(stream.stream, { inputType: stream.type, inlineVolume: true });
    }
  } catch (e3) {
    console.warn('getStream attempt 3 failed:', e3.message);
  }

  throw new Error(`Не вдалося отримати аудіо для: ${track.title}`);
}

// ───────────────────────────────────────────────
// ВІДТВОРЕННЯ НАСТУПНОГО ТРЕКУ
// ───────────────────────────────────────────────
async function playNext(guildId, client) {
  const q = client.queues.get(guildId);
  if (!q) return;

  if (q.loop === 'track' && q.currentTrack) {
    // залишаємо поточний
  } else if (q.tracks.length > 0) {
    if (q.loop === 'queue' && q.currentTrack) q.tracks.push(q.currentTrack);
    q.currentTrack = q.tracks.shift();
  } else {
    q.currentTrack = null;
    updatePanel(q, client).catch(() => {});
    return;
  }

  try {
    const resource = await getStream(q.currentTrack);
    resource.volume?.setVolume(q.volume / 100);
    q.player.play(resource);
    updatePanel(q, client).catch(() => {});
  } catch (e) {
    console.error('playNext error:', e.message);
    if (q.tracks.length > 0) { q.currentTrack = null; playNext(guildId, client); }
    else { q.currentTrack = null; updatePanel(q, client).catch(() => {}); }
  }
}

// ───────────────────────────────────────────────
// ПІДКЛЮЧЕННЯ ДО ГОЛОСОВОГО КАНАЛУ
// ───────────────────────────────────────────────
async function connectVoice(interaction, queue, client) {
  const vc = interaction.member.voice.channel;
  if (!vc) throw new Error('Ти не в голосовому каналі!');
  queue.voiceChannel = vc;

  // Якщо вже є живе Ready з'єднання — перевикористовуємо
  if (queue.connection &&
      queue.connection.state.status === VoiceConnectionStatus.Ready) {
    return;
  }

  // Знищуємо старе якщо є
  if (queue.connection &&
      queue.connection.state.status !== VoiceConnectionStatus.Destroyed) {
    queue.connection.destroy();
  }

  const connection = joinVoiceChannel({
    channelId: vc.id,
    guildId: vc.guild.id,
    adapterCreator: vc.guild.voiceAdapterCreator,
    selfDeaf: true,
  });

  // Workaround для хостингів за NAT/firewall (Wispbyte, Railway тощо)
  // Петля signalling→connecting означає що UDP пакети блокуються —
  // підписуємось на networkStateChange і форсуємо перехід
  connection.on('stateChange', (oldState, newState) => {
    const oldNet = oldState.networking ?? null;
    const newNet = newState.networking ?? null;
    if (oldNet !== newNet) {
      const onNetworkStateChange = (oldNetState, newNetState) => {
        const oldUdp = Reflect.get(oldNetState, 'udpSocket');
        const newUdp = Reflect.get(newNetState, 'udpSocket');
        if (oldUdp !== newUdp) {
          newUdp?.setTTL(255);
        }
      };
      oldNet?.off('stateChange', onNetworkStateChange);
      newNet?.on('stateChange', onNetworkStateChange);
    }
  });

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      connection.removeAllListeners('stateChange');
      connection.removeAllListeners('error');
      if (connection.state.status !== VoiceConnectionStatus.Destroyed) {
        connection.destroy();
      }
      reject(new Error('Таймаут підключення. Хостинг може блокувати UDP/голос.'));
    }, 20_000);

    if (connection.state.status === VoiceConnectionStatus.Ready) {
      clearTimeout(timeout);
      return resolve();
    }

    const onStateChange = (_, newState) => {
      console.log(`Voice: ${_.status} → ${newState.status}`);
      if (newState.status === VoiceConnectionStatus.Ready) {
        clearTimeout(timeout);
        connection.off('stateChange', onStateChange);
        resolve();
      } else if (newState.status === VoiceConnectionStatus.Destroyed) {
        clearTimeout(timeout);
        connection.off('stateChange', onStateChange);
        reject(new Error('З\'єднання знищено.'));
      }
    };

    connection.on('stateChange', onStateChange);
    connection.on('error', (e) => {
      clearTimeout(timeout);
      if (connection.state.status !== VoiceConnectionStatus.Destroyed) connection.destroy();
      reject(new Error(`Помилка з'єднання: ${e.message}`));
    });
  });

  const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Pause } });
  connection.subscribe(player);
  queue.connection = connection;
  queue.player = player;

  player.on(AudioPlayerStatus.Idle, () => playNext(vc.guild.id, client));
  player.on('error', (e) => { console.error('Player error:', e.message); playNext(vc.guild.id, client); });

  connection.on(VoiceConnectionStatus.Disconnected, async () => {
    try {
      await Promise.race([
        entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
        entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
      ]);
    } catch {
      connection.destroy();
      client.queues.delete(vc.guild.id);
    }
  });
}

// ───────────────────────────────────────────────
// ПАНЕЛЬ — EMBED
// ───────────────────────────────────────────────
function buildEmbed(q) {
  const embed = new EmbedBuilder().setColor(0x5865F2).setTimestamp();

  if (!q?.currentTrack) {
    return embed
      .setTitle('🎵 Музична Панель')
      .setDescription('```\n  ♪  Черга порожня  ♪\n```\nВикористай `/play` щоб почати!')
      .addFields(
        { name: '📋 Черга',    value: '`Порожня`',                        inline: true },
        { name: '🔊 Гучність', value: `\`${q?.volume ?? 80}%\``,           inline: true },
        { name: '🔁 Повтор',  value: `\`${loopLabel(q?.loop ?? 'none')}\``, inline: true },
      )
      .setFooter({ text: 'Музичний бот • /play для старту' });
  }

  const t = q.currentTrack;
  const paused = q.player?.state?.status === AudioPlayerStatus.Paused;

  embed
    .setTitle(`${paused ? '⏸️' : '▶️'} ${t.title}`)
    .setURL(t.url)
    .setDescription(
      `> ${srcEmoji(t.source)} **[${t.title}](${t.url})**\n\n` +
      `⏱ \`${formatDuration(t.duration)}\`  •  👤 \`${t.requestedBy || 'Невідомо'}\``
    )
    .addFields(
      { name: '📋 В черзі',   value: `\`${q.tracks.length} треків\``,      inline: true },
      { name: '🔊 Гучність',  value: `\`${q.volume}%\``,                    inline: true },
      { name: '🔁 Повтор',   value: `\`${loopLabel(q.loop)}\``,             inline: true },
    );

  if (q.tracks.length > 0) {
    embed.addFields({
      name: '⏭️ Далі',
      value: q.tracks.slice(0, 3).map((tr, i) =>
        `\`${i+1}.\` ${srcEmoji(tr.source)} ${tr.title.substring(0,45)}${tr.title.length>45?'…':''}`
      ).join('\n'),
    });
  }

  if (t.thumbnail) embed.setThumbnail(t.thumbnail);
  embed.setFooter({ text: `Музичний бот • ${new Date().toLocaleTimeString('uk-UA')}` });
  return embed;
}

// ───────────────────────────────────────────────
// ПАНЕЛЬ — КНОПКИ
// ───────────────────────────────────────────────
function buildButtons(q) {
  const has = !!q?.currentTrack;
  const paused = q?.player?.state?.status === AudioPlayerStatus.Paused;

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('m_pause').setEmoji(paused ? '▶️' : '⏸️').setLabel(paused ? 'Продовжити' : 'Пауза').setStyle(paused ? ButtonStyle.Success : ButtonStyle.Primary).setDisabled(!has),
    new ButtonBuilder().setCustomId('m_skip') .setEmoji('⏭️').setLabel('Пропустити').setStyle(ButtonStyle.Secondary).setDisabled(!has),
    new ButtonBuilder().setCustomId('m_stop') .setEmoji('⏹️').setLabel('Стоп')      .setStyle(ButtonStyle.Danger)   .setDisabled(!q),
    new ButtonBuilder().setCustomId('m_loop') .setEmoji('🔁').setLabel(`Повтор: ${loopLabel(q?.loop??'none')}`).setStyle(q?.loop!=='none'?ButtonStyle.Success:ButtonStyle.Secondary).setDisabled(!q),
  );

  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('m_shuffle')  .setEmoji('🔀').setLabel('Мікс')  .setStyle(ButtonStyle.Secondary).setDisabled(!q||q.tracks.length<2),
    new ButtonBuilder().setCustomId('m_vol_down') .setEmoji('🔉').setLabel('-10%')  .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('m_vol_up')   .setEmoji('🔊').setLabel('+10%')  .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('m_queue')    .setEmoji('📋').setLabel('Черга') .setStyle(ButtonStyle.Secondary),
  );

  const row3 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('m_play_modal') .setEmoji('▶️').setLabel('Почати')   .setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('m_leave')      .setEmoji('🚪').setLabel('Вийти')    .setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('m_clear_modal').setEmoji('🧹').setLabel('Очистити') .setStyle(ButtonStyle.Secondary),
  );

  return [row1, row2, row3];
}

// ───────────────────────────────────────────────
// ОНОВЛЕННЯ ПАНЕЛІ
// ───────────────────────────────────────────────
async function updatePanel(q, client) {
  if (!q?.panelMessage || !q?.panelChannelId) return;
  try {
    const ch = await client.channels.fetch(q.panelChannelId).catch(() => null);
    if (!ch) return;
    const msg = await ch.messages.fetch(q.panelMessage).catch(() => null);
    if (!msg) return;
    await msg.edit({ embeds: [buildEmbed(q)], components: buildButtons(q) });
  } catch (e) {
    console.error('updatePanel error:', e.message);
  }
}

// ───────────────────────────────────────────────
// DISCORD CLIENT
// ───────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
  ],
  partials: [Partials.Message, Partials.Channel],
});

client.commands = new Collection();
client.queues   = new Map();

// ───────────────────────────────────────────────
// ОБРОБКА КОМАНД
// ───────────────────────────────────────────────
async function handleCommand(interaction) {
  const { commandName, guildId, member } = interaction;

  // ── /panel ──────────────────────────────────
  if (commandName === 'panel') {
    const old = client.queues.get(guildId);
    if (old?.panelMessage) {
      try {
        const ch = await client.channels.fetch(old.panelChannelId).catch(() => null);
        if (ch) { const m = await ch.messages.fetch(old.panelMessage).catch(() => null); if (m) await m.delete().catch(() => {}); }
      } catch {}
    }

    const q = old || makeQueue(guildId);
    if (!old) client.queues.set(guildId, q);

    await interaction.reply({ content: '✅ Панель встановлена!', flags: 64 });
    const msg = await interaction.channel.send({ embeds: [buildEmbed(q)], components: buildButtons(q) });
    q.panelMessage    = msg.id;
    q.panelChannelId  = interaction.channelId;
    q.textChannel     = interaction.channel;
    return;
  }

  // ── /play ────────────────────────────────────
  if (commandName === 'play') {
    await interaction.deferReply({ flags: 64 });
    if (!member.voice.channel) return interaction.editReply('❌ Зайди в голосовий канал!');

    let q = client.queues.get(guildId);
    if (!q) { q = makeQueue(guildId); q.textChannel = interaction.channel; client.queues.set(guildId, q); }

    if (!q.connection || q.connection.state.status === VoiceConnectionStatus.Destroyed) {
      try { await connectVoice(interaction, q, client); }
      catch (e) { return interaction.editReply(`❌ ${e.message}`); }
    }

    await interaction.editReply('🔍 Шукаю трек...');
    const tracks = await searchTrack(interaction.options.getString('query'));
    if (!tracks.length) return interaction.editReply('❌ Нічого не знайдено!');
    tracks.forEach(t => { t.requestedBy = interaction.user.tag; });
    q.tracks.push(...tracks);

    await interaction.editReply(
      tracks.length === 1
        ? `✅ Додано: **${tracks[0].title}** ${srcEmoji(tracks[0].source)} (${formatDuration(tracks[0].duration)})`
        : `✅ Додано **${tracks.length}** треків ${srcEmoji(tracks[0].source)}`
    );

    if (!q.currentTrack) await playNext(guildId, client);
    else updatePanel(q, client).catch(() => {});
    return;
  }

  // ── /skip ────────────────────────────────────
  if (commandName === 'skip') {
    const q = client.queues.get(guildId);
    if (!q?.currentTrack) return interaction.reply({ content: '❌ Зараз нічого не грає!', flags: 64 });
    q.player?.stop();
    return interaction.reply({ content: '⏭️ Пропущено!', flags: 64 });
  }

  // ── /stop ────────────────────────────────────
  if (commandName === 'stop') {
    const q = client.queues.get(guildId);
    if (!q) return interaction.reply({ content: '❌ Бот не грає!', flags: 64 });
    const panel = { msg: q.panelMessage, ch: q.panelChannelId };
    q.tracks = []; q.currentTrack = null; q.player?.stop(); q.connection?.destroy();
    client.queues.delete(guildId);
    const empty = makeQueue(guildId);
    empty.panelMessage = panel.msg; empty.panelChannelId = panel.ch;
    client.queues.set(guildId, empty);
    await interaction.reply({ content: '⏹️ Зупинено!', flags: 64 });
    updatePanel(empty, client).catch(() => {});
    return;
  }

  // ── /pause ───────────────────────────────────
  if (commandName === 'pause') {
    const q = client.queues.get(guildId);
    if (!q?.currentTrack) return interaction.reply({ content: '❌ Зараз нічого не грає!', flags: 64 });
    const p = q.player;
    if (p.state.status === AudioPlayerStatus.Paused) { p.unpause(); await interaction.reply({ content: '▶️ Продовжено!', flags: 64 }); }
    else { p.pause(); await interaction.reply({ content: '⏸️ Пауза!', flags: 64 }); }
    updatePanel(q, client).catch(() => {});
    return;
  }

  // ── /queue ───────────────────────────────────
  if (commandName === 'queue') {
    const q = client.queues.get(guildId);
    if (!q?.currentTrack && !q?.tracks.length) return interaction.reply({ content: '❌ Черга порожня!', flags: 64 });
    const embed = new EmbedBuilder().setColor(0x5865F2).setTitle('📋 Черга треків');
    if (q.currentTrack) embed.addFields({ name: '▶️ Зараз', value: `${srcEmoji(q.currentTrack.source)} **${q.currentTrack.title}** — ${formatDuration(q.currentTrack.duration)}` });
    if (q.tracks.length) {
      const list = q.tracks.slice(0,15).map((t,i)=>`\`${i+1}.\` ${srcEmoji(t.source)} ${t.title.substring(0,45)} — ${formatDuration(t.duration)}`).join('\n');
      embed.addFields({ name: `📋 Черга (${q.tracks.length})`, value: list + (q.tracks.length>15?`\n*...і ще ${q.tracks.length-15}*`:'') });
    }
    return interaction.reply({ embeds: [embed], flags: 64 });
  }

  // ── /volume ──────────────────────────────────
  if (commandName === 'volume') {
    const q = client.queues.get(guildId);
    if (!q) return interaction.reply({ content: '❌ Бот не грає!', flags: 64 });
    const lv = interaction.options.getInteger('level');
    q.volume = lv;
    if (q.player?.state?.resource?.volume) q.player.state.resource.volume.setVolume(lv/100);
    await interaction.reply({ content: `🔊 Гучність: **${lv}%**`, flags: 64 });
    updatePanel(q, client).catch(() => {});
    return;
  }

  // ── /nowplaying ──────────────────────────────
  if (commandName === 'nowplaying') {
    const q = client.queues.get(guildId);
    if (!q?.currentTrack) return interaction.reply({ content: '❌ Зараз нічого не грає!', flags: 64 });
    const t = q.currentTrack;
    const embed = new EmbedBuilder().setColor(0x5865F2)
      .setTitle(`${srcEmoji(t.source)} Зараз грає`)
      .setDescription(`**[${t.title}](${t.url})**`)
      .addFields(
        { name: '⏱ Тривалість', value: formatDuration(t.duration), inline: true },
        { name: '👤 Додав',     value: t.requestedBy || 'Невідомо', inline: true },
        { name: '🔊 Гучність',  value: `${q.volume}%`,               inline: true },
      ).setTimestamp();
    if (t.thumbnail) embed.setThumbnail(t.thumbnail);
    return interaction.reply({ embeds: [embed], flags: 64 });
  }

  // ── /shuffle ─────────────────────────────────
  if (commandName === 'shuffle') {
    const q = client.queues.get(guildId);
    if (!q || q.tracks.length < 2) return interaction.reply({ content: '❌ Мало треків!', flags: 64 });
    for (let i = q.tracks.length-1; i>0; i--) { const j=Math.floor(Math.random()*(i+1)); [q.tracks[i],q.tracks[j]]=[q.tracks[j],q.tracks[i]]; }
    await interaction.reply({ content: `🔀 Перемішано! (${q.tracks.length} треків)`, flags: 64 });
    updatePanel(q, client).catch(() => {});
    return;
  }

  // ── /loop ────────────────────────────────────
  if (commandName === 'loop') {
    const q = client.queues.get(guildId);
    if (!q) return interaction.reply({ content: '❌ Бот не грає!', flags: 64 });
    const modes = ['none','track','queue'];
    const labels = { none: '🚫 Вимкнено', track: '🔂 Трек', queue: '🔁 Черга' };
    q.loop = modes[(modes.indexOf(q.loop)+1)%modes.length];
    await interaction.reply({ content: `Повтор: **${labels[q.loop]}**`, flags: 64 });
    updatePanel(q, client).catch(() => {});
    return;
  }

  // ── /remove ──────────────────────────────────
  if (commandName === 'remove') {
    const q = client.queues.get(guildId);
    if (!q?.tracks.length) return interaction.reply({ content: '❌ Черга порожня!', flags: 64 });
    const pos = interaction.options.getInteger('position');
    if (pos > q.tracks.length) return interaction.reply({ content: `❌ Позиція ${pos} не існує!`, flags: 64 });
    const removed = q.tracks.splice(pos-1,1)[0];
    await interaction.reply({ content: `🗑️ Видалено: **${removed.title}**`, flags: 64 });
    updatePanel(q, client).catch(() => {});
    return;
  }

  // ── /clear ───────────────────────────────────
  if (commandName === 'clear') {
    if (!member.permissions.has(PermissionFlagsBits.ManageMessages))
      return interaction.reply({ content: '❌ Немає прав `Manage Messages`!', flags: 64 });

    await interaction.deferReply({ flags: 64 });
    const amount  = interaction.options.getInteger('amount');
    const target  = interaction.options.getChannel('channel') ?? interaction.channel;

    if (![ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.PublicThread, ChannelType.PrivateThread].includes(target.type))
      return interaction.editReply('❌ Можна очищати тільки текстові канали!');

    const botPerms = target.permissionsFor(interaction.guild.members.cache.get(client.user.id));
    if (!botPerms?.has(PermissionFlagsBits.ManageMessages))
      return interaction.editReply(`❌ Немає прав для видалення в ${target}!`);

    let deleted = 0, remaining = amount;
    const twoWeeks = Date.now() - 14*24*60*60*1000;

    while (remaining > 0) {
      const msgs = await target.messages.fetch({ limit: Math.min(remaining, 100) });
      if (!msgs.size) break;

      const fresh = msgs.filter(m => m.createdTimestamp > twoWeeks);
      const old   = msgs.filter(m => m.createdTimestamp <= twoWeeks);

      if (fresh.size) {
        const d = await target.bulkDelete(fresh, true).catch(() => ({ size: 0 }));
        deleted += d.size; remaining -= d.size;
      }
      for (const [, m] of old) {
        if (remaining <= 0) break;
        await m.delete().catch(() => {}); deleted++; remaining--;
        await new Promise(r => setTimeout(r, 300));
      }
      if (msgs.size < 100) break;
      if (remaining > 0) await new Promise(r => setTimeout(r, 1000));
    }

    const embed = new EmbedBuilder().setColor(0x57F287).setTitle('🧹 Очищення каналу')
      .addFields(
        { name: '📍 Канал',    value: `${target}`,          inline: true },
        { name: '🗑️ Видалено', value: `**${deleted}** повідомлень`, inline: true },
        { name: '👤 Виконав',  value: interaction.user.tag,  inline: true },
      ).setTimestamp();
    return interaction.editReply({ embeds: [embed] });
  }
}

// ───────────────────────────────────────────────
// ОБРОБКА КНОПОК
// ───────────────────────────────────────────────
async function handleButton(interaction) {
  const { customId, guildId, member } = interaction;
  if (!customId.startsWith('m_')) return;

  const q = client.queues.get(guildId);

  if (customId === 'm_queue') {
    if (!q?.currentTrack && !q?.tracks.length) return interaction.reply({ content: '❌ Черга порожня!', flags: 64 });
    const embed = new EmbedBuilder().setColor(0x5865F2).setTitle('📋 Черга треків');
    if (q.currentTrack) embed.addFields({ name: '▶️ Зараз', value: `${srcEmoji(q.currentTrack.source)} **${q.currentTrack.title}** — ${formatDuration(q.currentTrack.duration)}` });
    if (q.tracks.length) embed.addFields({ name: `📋 (${q.tracks.length})`, value: q.tracks.slice(0,15).map((t,i)=>`\`${i+1}.\` ${srcEmoji(t.source)} ${t.title.substring(0,45)} — ${formatDuration(t.duration)}`).join('\n') });
    return interaction.reply({ embeds: [embed], flags: 64 });
  }

  if (customId === 'm_vol_up' || customId === 'm_vol_down') {
    if (!q) return interaction.reply({ content: '❌ Бот не грає!', flags: 64 });
    q.volume = Math.max(0, Math.min(100, q.volume + (customId==='m_vol_up'?10:-10)));
    if (q.player?.state?.resource?.volume) q.player.state.resource.volume.setVolume(q.volume/100);
    await interaction.reply({ content: `🔊 Гучність: **${q.volume}%**`, flags: 64 });
    updatePanel(q, client).catch(() => {});
    return;
  }

  if (!member.voice.channel) return interaction.reply({ content: '❌ Зайди в голосовий канал!', flags: 64 });

  if (customId === 'm_pause') {
    if (!q?.currentTrack) return interaction.reply({ content: '❌ Нічого не грає!', flags: 64 });
    if (q.player.state.status === AudioPlayerStatus.Paused) { q.player.unpause(); await interaction.reply({ content: '▶️ Продовжено!', flags: 64 }); }
    else { q.player.pause(); await interaction.reply({ content: '⏸️ Пауза!', flags: 64 }); }
    updatePanel(q, client).catch(() => {});
    return;
  }

  if (customId === 'm_skip') {
    if (!q?.currentTrack) return interaction.reply({ content: '❌ Нічого не грає!', flags: 64 });
    q.player?.stop();
    return interaction.reply({ content: '⏭️ Пропущено!', flags: 64 });
  }

  if (customId === 'm_stop') {
    if (!q) return interaction.reply({ content: '❌ Бот не грає!', flags: 64 });
    const panel = { msg: q.panelMessage, ch: q.panelChannelId };
    q.tracks=[]; q.currentTrack=null; q.loop='none'; q.player?.stop(); q.connection?.destroy();
    client.queues.delete(guildId);
    const empty = makeQueue(guildId);
    empty.panelMessage=panel.msg; empty.panelChannelId=panel.ch;
    client.queues.set(guildId, empty);
    await interaction.reply({ content: '⏹️ Зупинено!', flags: 64 });
    updatePanel(empty, client).catch(() => {});
    return;
  }

  if (customId === 'm_shuffle') {
    if (!q||q.tracks.length<2) return interaction.reply({ content: '❌ Мало треків!', flags: 64 });
    for (let i=q.tracks.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[q.tracks[i],q.tracks[j]]=[q.tracks[j],q.tracks[i]];}
    await interaction.reply({ content: `🔀 Перемішано! (${q.tracks.length})`, flags: 64 });
    updatePanel(q, client).catch(() => {});
    return;
  }

  if (customId === 'm_loop') {
    if (!q) return interaction.reply({ content: '❌ Бот не грає!', flags: 64 });
    const modes=['none','track','queue'];
    const labels={none:'🚫 Вимкнено',track:'🔂 Трек',queue:'🔁 Черга'};
    q.loop=modes[(modes.indexOf(q.loop)+1)%modes.length];
    await interaction.reply({ content: `Повтор: **${labels[q.loop]}**`, flags: 64 });
    updatePanel(q, client).catch(() => {});
    return;
  }

  // ── Почати — показати modal з полем пошуку ───
  if (customId === 'm_play_modal') {
    const modal = new ModalBuilder()
      .setCustomId('modal_play')
      .setTitle('▶️ Відтворити музику');

    const input = new TextInputBuilder()
      .setCustomId('play_query')
      .setLabel('Посилання або назва пісні')
      .setStyle(TextInputStyle.Short)
      .setPlaceholder('https://youtube.com/... або назва треку')
      .setRequired(true);

    modal.addComponents(new ActionRowBuilder().addComponents(input));
    return interaction.showModal(modal);
  }

  // ── Вийти — бот залишає голосовий канал ─────
  if (customId === 'm_leave') {
    const qq = client.queues.get(guildId);
    if (!qq?.connection) return interaction.reply({ content: '❌ Бот не в голосовому каналі!', flags: 64 });
    const panel = { msg: qq.panelMessage, ch: qq.panelChannelId };
    qq.tracks = []; qq.currentTrack = null; qq.player?.stop(); qq.connection.destroy();
    client.queues.delete(guildId);
    const empty = makeQueue(guildId);
    empty.panelMessage = panel.msg; empty.panelChannelId = panel.ch;
    client.queues.set(guildId, empty);
    await interaction.reply({ content: '🚪 Бот залишив голосовий канал!', flags: 64 });
    updatePanel(empty, client).catch(() => {});
    return;
  }

  // ── Очистити — показати select menu каналів ─
  if (customId === 'm_clear_modal') {
    if (!member.permissions.has(PermissionFlagsBits.ManageMessages))
      return interaction.reply({ content: '❌ Немає прав `Manage Messages`!', flags: 64 });

    const textChannels = interaction.guild.channels.cache
      .filter(c => [ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(c.type))
      .sort((a, b) => a.position - b.position)
      .first(25);

    if (!textChannels.size) return interaction.reply({ content: '❌ Немає текстових каналів!', flags: 64 });

    const options = textChannels.map(c =>
      new StringSelectMenuOptionBuilder()
        .setLabel(`# ${c.name}`)
        .setValue(c.id)
        .setDescription(c.topic ? c.topic.substring(0, 50) : 'Текстовий канал')
    );

    const select = new StringSelectMenuBuilder()
      .setCustomId('clear_channel_select')
      .setPlaceholder('Оберіть канал для очищення...')
      .addOptions(options);

    const amountModal = new ModalBuilder()
      .setCustomId('modal_clear')
      .setTitle('🧹 Очистити повідомлення');

    const channelInput = new TextInputBuilder()
      .setCustomId('clear_channel_id')
      .setLabel('ID каналу (або залиш порожнім — поточний)')
      .setStyle(TextInputStyle.Short)
      .setPlaceholder('Оберіть зі списку нижче або залиш порожнім')
      .setRequired(false);

    const amountInput = new TextInputBuilder()
      .setCustomId('clear_amount')
      .setLabel('Кількість повідомлень (1–100)')
      .setStyle(TextInputStyle.Short)
      .setPlaceholder('Наприклад: 50')
      .setRequired(true);

    amountModal.addComponents(
      new ActionRowBuilder().addComponents(channelInput),
      new ActionRowBuilder().addComponents(amountInput),
    );

    // Спочатку показуємо select menu
    const selectRow = new ActionRowBuilder().addComponents(select);
    return interaction.reply({
      content: '🧹 **Крок 1:** Оберіть канал для очищення:',
      components: [selectRow],
      flags: 64,
    });
  }
}

// ───────────────────────────────────────────────
// ОБРОБКА МОДАЛЬНИХ ВІКОН
// ───────────────────────────────────────────────
async function handleModal(interaction) {
  const { customId, guildId, member } = interaction;

  // ── modal_play — відтворити трек ─────────────
  if (customId === 'modal_play') {
    const query = interaction.fields.getTextInputValue('play_query').trim();
    if (!query) return interaction.reply({ content: '❌ Введи назву або посилання!', flags: 64 });
    if (!member.voice.channel) return interaction.reply({ content: '❌ Зайди в голосовий канал!', flags: 64 });

    await interaction.deferReply({ flags: 64 });

    let q = client.queues.get(guildId);
    if (!q) { q = makeQueue(guildId); q.textChannel = interaction.channel; client.queues.set(guildId, q); }

    if (!q.connection || q.connection.state.status === VoiceConnectionStatus.Destroyed) {
      try { await connectVoice(interaction, q, client); }
      catch (e) { return interaction.editReply(`❌ ${e.message}`); }
    }

    await interaction.editReply('🔍 Шукаю трек...');
    const tracks = await searchTrack(query);
    if (!tracks.length) return interaction.editReply('❌ Нічого не знайдено!');
    tracks.forEach(t => { t.requestedBy = interaction.user.tag; });
    q.tracks.push(...tracks);

    await interaction.editReply(
      tracks.length === 1
        ? `✅ Додано: **${tracks[0].title}** ${srcEmoji(tracks[0].source)} (${formatDuration(tracks[0].duration)})`
        : `✅ Додано **${tracks.length}** треків ${srcEmoji(tracks[0].source)}`
    );

    if (!q.currentTrack) await playNext(guildId, client);
    else updatePanel(q, client).catch(() => {});
    return;
  }

  // ── modal_clear_amount — після вибору каналу ─
  if (customId.startsWith('modal_clear_amount:')) {
    const channelId = customId.split(':')[1];
    const amountRaw = interaction.fields.getTextInputValue('clear_amount');
    const amount = Math.min(100, Math.max(1, parseInt(amountRaw) || 0));
    if (!amount) return interaction.reply({ content: '❌ Введи число від 1 до 100!', flags: 64 });

    if (!member.permissions.has(PermissionFlagsBits.ManageMessages))
      return interaction.reply({ content: '❌ Немає прав `Manage Messages`!', flags: 64 });

    await interaction.deferReply({ flags: 64 });

    const target = interaction.guild.channels.cache.get(channelId) ?? interaction.channel;
    if (![ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.PublicThread, ChannelType.PrivateThread].includes(target.type))
      return interaction.editReply('❌ Можна очищати тільки текстові канали!');

    const botPerms = target.permissionsFor(interaction.guild.members.cache.get(client.user.id));
    if (!botPerms?.has(PermissionFlagsBits.ManageMessages))
      return interaction.editReply(`❌ Немає прав для видалення в ${target}!`);

    let deleted = 0, remaining = amount;
    const twoWeeks = Date.now() - 14*24*60*60*1000;

    while (remaining > 0) {
      const msgs = await target.messages.fetch({ limit: Math.min(remaining, 100) });
      if (!msgs.size) break;
      const fresh = msgs.filter(m => m.createdTimestamp > twoWeeks);
      const old   = msgs.filter(m => m.createdTimestamp <= twoWeeks);
      if (fresh.size) {
        const d = await target.bulkDelete(fresh, true).catch(() => ({ size: 0 }));
        deleted += d.size; remaining -= d.size;
      }
      for (const [, m] of old) {
        if (remaining <= 0) break;
        await m.delete().catch(() => {}); deleted++; remaining--;
        await new Promise(r => setTimeout(r, 300));
      }
      if (msgs.size < 100) break;
      if (remaining > 0) await new Promise(r => setTimeout(r, 1000));
    }

    const embed = new EmbedBuilder().setColor(0x57F287).setTitle('🧹 Очищення каналу')
      .addFields(
        { name: '📍 Канал',    value: `${target}`,                    inline: true },
        { name: '🗑️ Видалено', value: `**${deleted}** повідомлень`,   inline: true },
        { name: '👤 Виконав',  value: interaction.user.tag,            inline: true },
      ).setTimestamp();
    return interaction.editReply({ embeds: [embed] });
  }
}

// ───────────────────────────────────────────────
// ОБРОБКА SELECT MENU
// ───────────────────────────────────────────────
async function handleSelectMenu(interaction) {
  const { customId, member } = interaction;

  // ── clear_channel_select — вибір каналу, далі питаємо кількість ─
  if (customId === 'clear_channel_select') {
    if (!member.permissions.has(PermissionFlagsBits.ManageMessages))
      return interaction.reply({ content: '❌ Немає прав `Manage Messages`!', flags: 64 });

    const channelId = interaction.values[0];
    const channel = interaction.guild.channels.cache.get(channelId);

    const modal = new ModalBuilder()
      .setCustomId(`modal_clear_amount:${channelId}`)
      .setTitle(`🧹 Очистити #${channel?.name ?? 'канал'}`);

    const amountInput = new TextInputBuilder()
      .setCustomId('clear_amount')
      .setLabel('Кількість повідомлень для видалення (1–100)')
      .setStyle(TextInputStyle.Short)
      .setPlaceholder('Наприклад: 50')
      .setRequired(true);

    modal.addComponents(new ActionRowBuilder().addComponents(amountInput));
    return interaction.showModal(modal);
  }
}

// ───────────────────────────────────────────────
// ───────────────────────────────────────────────
client.once('clientReady', async () => {
  console.log(`✅ Бот запущено як ${client.user.tag}`);
  client.user.setActivity('🎵 Музика | /panel', { type: ActivityType.Listening });
  await deployCommands(); // ← автоматичний деплой команд
});

client.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) await handleCommand(interaction);
    else if (interaction.isButton())      await handleButton(interaction);
    else if (interaction.isModalSubmit()) await handleModal(interaction);
    else if (interaction.isStringSelectMenu()) await handleSelectMenu(interaction);
  } catch (e) {
    console.error('Interaction error:', e);
    const reply = { content: '❌ Сталася помилка!', flags: 64 };
    if (interaction.replied || interaction.deferred) await interaction.followUp(reply).catch(() => {});
    else await interaction.reply(reply).catch(() => {});
  }
});

client.on('voiceStateUpdate', (oldState) => {
  const q = client.queues.get(oldState.guild.id);
  if (!q) return;
  const botCh = oldState.guild.members.cache.get(client.user.id)?.voice?.channel;
  if (!botCh) return;
  if (botCh.members.filter(m => !m.user.bot).size === 0) {
    setTimeout(() => {
      const qq = client.queues.get(oldState.guild.id);
      if (qq) { qq.connection?.destroy(); client.queues.delete(oldState.guild.id); }
    }, 30_000);
  }
});

// ───────────────────────────────────────────────
// СТАРТ
// ───────────────────────────────────────────────
initPlayDL().then(() => client.login(process.env.DISCORD_TOKEN));
