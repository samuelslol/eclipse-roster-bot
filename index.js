// Definir el ID del canal de roster desde variable de entorno
const ROSTER_CHANNEL_ID = process.env.ROSTER_CHANNEL_ID || '1373410183853772849';
// Carga variables desde .env si existe
try { require('dotenv').config(); } catch (_) { /* dotenv no instalado todavía */ }

const { Client, GatewayIntentBits, EmbedBuilder, PermissionsBitField } = require("discord.js");

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers
  ]
});

// ------------------------------------------------------
// Lightweight HTTP health endpoint (para plataformas como Koyeb / Replit)
// Mantiene el contenedor "healthy" aunque el bot solo use WebSocket.
// Si la plataforma no lo requiere, no afecta.
// Puerto configurable vía PORT o 8080 por defecto.
// ------------------------------------------------------
try {
  const http = require('http');
  const HEALTH_PORT = process.env.PORT || 8080;
  http.createServer((_, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('OK\n');
  }).listen(HEALTH_PORT, () => console.log(`🌐 Healthcheck HTTP server listening on :${HEALTH_PORT}`));
} catch (e) {
  console.warn('No se pudo iniciar servidor HTTP de healthcheck:', e.message);
}

// Roster actualizado (en memoria)

const fs = require('fs');
const STATE_FILE = 'state.json';
let roster = {
  Council: [],
  Staff: [],
  Moderador: [],
  Eclipse: [],
  Trial: []
};

// Cargar roster desde archivo si existe
try {
  if (fs.existsSync(STATE_FILE)) {
    const data = fs.readFileSync(STATE_FILE, 'utf8');
    const obj = JSON.parse(data);
    if (obj && typeof obj === 'object') roster = obj;
    console.log('✅ Roster cargado desde state.json');
  }
} catch (e) {
  console.warn('No se pudo cargar state.json:', e.message);
}

// Guardar roster en archivo (debounce para evitar escrituras excesivas)
let saveTimeout = null;
function saveRoster() {
  if (saveTimeout) clearTimeout(saveTimeout);
  saveTimeout = setTimeout(() => {
    try {
      fs.writeFileSync(STATE_FILE, JSON.stringify(roster, null, 2), 'utf8');
      console.log('💾 Roster guardado en state.json');
    } catch (e) {
      console.warn('No se pudo guardar state.json:', e.message);
    }
  }, 500);
}

// Estilos disponibles para mostrar miembros de cada categoría
const memberStyles = {
  estrella: (n) => `✦ ${n}`,
  flecha:   (n) => `➤ ${n}`,
  diamante: (n) => `◆ ${n}`,
  sparkle:  (n) => `✨ ${n}`,
  fancy:    (n) => `✧彡 ${n}`,
  bracket:  (n) => `【${n}】`,
  corona:   (n) => `👑 ${n}`
};

let currentStyleKey = 'estrella';

function formatMember(name) {
  const fn = memberStyles[currentStyleKey] || memberStyles['estrella'];
  return fn(name);
}

// Reemplaza la primera letra de la categoría por su versión en script (unicode) si existe
function fancyCategoryName(name) {
  const scriptMap = {
    A: '𝓐', B: '𝓑', C: '𝓒', D: '𝓓', E: '𝓔', F: '𝓕', G: '𝓖', H: '𝓗', I: '𝓘', J: '𝓙',
    K: '𝓚', L: '𝓛', M: '𝓜', N: '𝓝', O: '𝓞', P: '𝓟', Q: '𝓠', R: '𝓡', S: '𝓢', T: '𝓣',
    U: '𝓤', V: '𝓥', W: '𝓦', X: '𝓧', Y: '𝓨', Z: '𝓩'
  };
  if (!name || !name.length) return name;
  const first = name.charAt(0);
  const mapped = scriptMap[first.toUpperCase()];
  if (!mapped) return name; // no mapeo disponible
  // Mantener el resto tal cual
  return mapped + name.slice(1);
}

// Resolver categoría a partir de fragmento parcial (prefijo o substring) con desambiguación
function resolveCategoryFragment(frag) {
  if (!frag) return { status: 'none' };
  const categories = Object.keys(roster);
  const lc = frag.toLowerCase();
  // Exact match
  const exact = categories.find(c => c.toLowerCase() === lc);
  if (exact) return { status: 'ok', category: exact };
  // Prefix matches
  const prefixMatches = categories.filter(c => c.toLowerCase().startsWith(lc));
  if (prefixMatches.length === 1) return { status: 'ok', category: prefixMatches[0] };
  if (prefixMatches.length > 1) return { status: 'ambiguous', matches: prefixMatches };
  // Includes matches
  const includeMatches = categories.filter(c => c.toLowerCase().includes(lc));
  if (includeMatches.length === 1) return { status: 'ok', category: includeMatches[0] };
  if (includeMatches.length > 1) return { status: 'ambiguous', matches: includeMatches };
  return { status: 'none' };
}

// Normaliza un nombre a Title Case (cada palabra con mayúscula inicial)
function normalizeDisplayName(raw) {
  return raw.split(/\s+/).filter(Boolean).map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
}

// Búsqueda inteligente: prioridad exact ==, luego startsWith, luego includes
function smartFindMember(guild, query) {
  const lc = query.toLowerCase();
  const pool = guild.members.cache.filter(m => {
    const dn = (m.displayName || '').toLowerCase();
    const un = (m.user.username || '').toLowerCase();
    return dn.includes(lc) || un.includes(lc);
  });
  if (!pool.size) return { status: 'none' };
  const exact = pool.filter(m => m.displayName.toLowerCase() === lc || m.user.username.toLowerCase() === lc);
  if (exact.size === 1) return { status: 'ok', member: exact.first() };
  const starts = pool.filter(m => m.displayName.toLowerCase().startsWith(lc) || m.user.username.toLowerCase().startsWith(lc));
  if (starts.size === 1) return { status: 'ok', member: starts.first() };
  if (pool.size === 1) return { status: 'ok', member: pool.first() };
  return { status: 'multi', matches: pool };
}

// Helper: unified warning embed (exceptions) in English
function buildWarnEmbed(text) {
  return new EmbedBuilder()
    .setColor('#E67E22') // orange
    .setDescription(`⚠️ ${text}`);
}

async function replyWarnMessage(message, text, { deleteMs } = {}) {
  try {
    const sent = await message.reply({ embeds: [buildWarnEmbed(text)], allowedMentions: { repliedUser: false } });
    if (deleteMs) setTimeout(() => sent.delete().catch(()=>{}), deleteMs);
  } catch (_) {}
}

// IDs para editar el mensaje central del roster
let rosterMessageId = null;
let rosterChannelId = null;

client.once("ready", async () => {
  console.log(`✅ Bot conectado como ${client.user.tag}`);
  // Mostrar estado "Jugando Gota.io"
  client.user.setActivity("Gota.io", { type: 0 });
  // Registro de slash commands (guild) para respuestas ephemeral
  const guildId = process.env.GUILD_ID; // Añade en .env si quieres registro rápido
  const commands = [
    {
      name: 'pass',
      description: 'Grant Eclipse & Trial roles and remove Guest',
      options: [
        { name: 'user', description: 'Target member', type: 6, required: true }
      ]
    },
    {
      name: 'purge',
      description: 'Remove Eclipse/Trial/Academy roles and add Guest',
      options: [
        { name: 'user', description: 'Target member', type: 6, required: true }
      ]
    },
    {
      name: 'eclp',
      description: 'Promote: remove Trial and add Eclipse (promo ID)',
      options: [
        { name: 'user', description: 'Target member', type: 6, required: true }
      ]
    }
  ];
  if (guildId) {
    try {
      await client.application.commands.set(commands, guildId);
      console.log(`🛠️ Slash commands registrados en guild ${guildId}`);
    } catch (err) {
      console.error('❌ Error registrando slash commands guild:', err);
    }
  } else {
    console.log('ℹ️ GUILD_ID no definido; omitiendo registro de slash commands guild. Añade GUILD_ID en .env para registro inmediato.');
  }
});

// ------------------------------------------------------
// Handler de slash commands (ephemeral support)
// ------------------------------------------------------
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const adminCheck = () => interaction.memberPermissions?.has(PermissionsBitField.Flags.Administrator);

  const sendPublicEmbed = (embed) => interaction.channel?.send({ embeds: [embed] }).catch(()=>{});

  if (interaction.commandName === 'pass') {
    if (!adminCheck()) return interaction.reply({ content: '❌ You need Administrator.', ephemeral: true });
    const target = interaction.options.getMember('user');
    if (!target) return interaction.reply({ content: '❌ Member not found.', ephemeral: true });
    if (!interaction.guild.members.me.permissions.has(PermissionsBitField.Flags.ManageRoles)) {
      return interaction.reply({ content: '❌ I lack Manage Roles permission.', ephemeral: true });
    }
    const ECLIPSE_ROLE_ID = '1373410183312703568';
    const GUEST_ROLE_ID   = '1373410183249920113';
    const TRIAL_ROLE_ID   = '1373410183312703569';
    const eclipseRole = interaction.guild.roles.cache.get(ECLIPSE_ROLE_ID);
    const guestRole   = interaction.guild.roles.cache.get(GUEST_ROLE_ID);
    const trialRole   = interaction.guild.roles.cache.get(TRIAL_ROLE_ID);
    if (!eclipseRole || !guestRole || !trialRole) {
      return interaction.reply({ content: '❌ Role IDs misconfigured.', ephemeral: true });
    }
    const botHighest = interaction.guild.members.me.roles.highest.position;
    for (const r of [eclipseRole, guestRole, trialRole]) {
      if (r.position >= botHighest) {
        return interaction.reply({ content: `❌ Cannot apply role ${r.name} (above me).`, ephemeral: true });
      }
    }
    const toAdd = []; const toRemove = []; const changes = [];
    if (!target.roles.cache.has(ECLIPSE_ROLE_ID)) { toAdd.push(ECLIPSE_ROLE_ID); changes.push(`+${eclipseRole.name}`); }
    if (!target.roles.cache.has(TRIAL_ROLE_ID))   { toAdd.push(TRIAL_ROLE_ID);   changes.push(`+${trialRole.name}`); }
    if (target.roles.cache.has(GUEST_ROLE_ID))    { toRemove.push(GUEST_ROLE_ID); changes.push(`-${guestRole.name}`); }
    if (!changes.length) return interaction.reply({ content: '⚠️ No changes to apply.', ephemeral: true });
    try {
      if (toAdd.length) await target.roles.add(toAdd, `Slash /pass by ${interaction.user.tag}`);
      if (toRemove.length) await target.roles.remove(toRemove, `Slash /pass by ${interaction.user.tag}`);
    } catch (err) {
      console.error('Slash /pass error:', err); return interaction.reply({ content: '❌ Error applying roles.', ephemeral: true });
    }
    const embed = new EmbedBuilder().setColor('#FFA500').setDescription(`✅ Changed roles for ${target}: ${changes.join(', ')}`);
    await interaction.reply({ content: '✅ Done', ephemeral: true });
    sendPublicEmbed(embed);
    return;
  }

  if (interaction.commandName === 'purge') {
    if (!adminCheck()) return interaction.reply({ content: '❌ You need Administrator.', ephemeral: true });
    const target = interaction.options.getMember('user');
    if (!target) return interaction.reply({ content: '❌ Member not found.', ephemeral: true });
    if (!interaction.guild.members.me.permissions.has(PermissionsBitField.Flags.ManageRoles)) {
      return interaction.reply({ content: '❌ I lack Manage Roles permission.', ephemeral: true });
    }
    const ECLIPSE_ROLE_IDS = ['1373410183312703570','1373410183312703568'];
    const TRIAL_ROLE_ID    = '1373410183312703569';
    const ACADEMY_ROLE_ID  = '1388667580407087154';
    const GUEST_ROLE_ID    = '1373410183249920113';
    const guestRole = interaction.guild.roles.cache.get(GUEST_ROLE_ID);
    if (!guestRole) return interaction.reply({ content: '❌ Guest role missing.', ephemeral: true });
    const toRemove = [];
    for (const rid of ECLIPSE_ROLE_IDS) if (target.roles.cache.has(rid)) toRemove.push(rid);
    if (target.roles.cache.has(TRIAL_ROLE_ID)) toRemove.push(TRIAL_ROLE_ID);
    if (target.roles.cache.has(ACADEMY_ROLE_ID)) toRemove.push(ACADEMY_ROLE_ID);
    const uniq = [...new Set(toRemove)];
    const changes = [];
    try {
      if (uniq.length) {
        await target.roles.remove(uniq, `Slash /purge by ${interaction.user.tag}`);
        for (const id of uniq) changes.push(`-${interaction.guild.roles.cache.get(id)?.name || id}`);
      }
    } catch (err) { console.error('Slash /purge remove error:', err); return interaction.reply({ content: '❌ Error removing roles.', ephemeral: true }); }
    if (!target.roles.cache.has(GUEST_ROLE_ID)) {
      try { await target.roles.add(GUEST_ROLE_ID, `Slash /purge by ${interaction.user.tag}`); changes.push(`+${guestRole.name}`); } catch (err) { console.error('Slash /purge add guest error:', err); return interaction.reply({ content: '❌ Error adding Guest.', ephemeral: true }); }
    }
    const hadNickname = !!target.nickname;
    if (hadNickname && interaction.guild.members.me.permissions.has(PermissionsBitField.Flags.ManageNicknames)) {
      try { await target.setNickname(null, `Slash /purge by ${interaction.user.tag}`); } catch(_) {}
    }
    if (!changes.length) return interaction.reply({ content: '⚠️ Nothing to purge.', ephemeral: true });
    const embed = new EmbedBuilder().setColor('#E74C3C').setDescription(`🧹 Purged roles for ${target}: ${changes.join(', ')}`);
    await interaction.reply({ content: '🧹 Purge done', ephemeral: true });
    sendPublicEmbed(embed);
    return;
  }

  if (interaction.commandName === 'eclp') {
    if (!adminCheck()) return interaction.reply({ content: '❌ You need Administrator.', ephemeral: true });
    const target = interaction.options.getMember('user');
    if (!target) return interaction.reply({ content: '❌ Member not found.', ephemeral: true });
    if (!interaction.guild.members.me.permissions.has(PermissionsBitField.Flags.ManageRoles)) {
      return interaction.reply({ content: '❌ I lack Manage Roles permission.', ephemeral: true });
    }
    const ECLIPSE_ROLE_ID_PROMO = '1373410183312703570';
    const ECLIPSE_ROLE_ID_BASE = '1373410183312703568'; // Also ensure base Eclipse role present
    const GUEST_ROLE_ID = '1373410183249920113'; // remove Guest if present
    const TRIAL_ROLE_ID = '1373410183312703569';
  const ACADEMY_ROLE_ID = '1388667580407087154'; // also add Academy role on promotion
    const eclipseRolePromo = interaction.guild.roles.cache.get(ECLIPSE_ROLE_ID_PROMO);
    const eclipseRoleBase = interaction.guild.roles.cache.get(ECLIPSE_ROLE_ID_BASE);
    const guestRole = interaction.guild.roles.cache.get(GUEST_ROLE_ID);
    const trialRole = interaction.guild.roles.cache.get(TRIAL_ROLE_ID);
  const academyRole = interaction.guild.roles.cache.get(ACADEMY_ROLE_ID);
  if (!eclipseRolePromo || !eclipseRoleBase || !trialRole) return interaction.reply({ content: '❌ Role IDs misconfigured.', ephemeral: true });
    const botHighest = interaction.guild.members.me.roles.highest.position;
  for (const r of [eclipseRolePromo, eclipseRoleBase, trialRole, guestRole, academyRole]) if (r && r.position >= botHighest) return interaction.reply({ content: `❌ Role ${r.name} is above me.`, ephemeral: true });
    const adds = []; const removes = []; const changes = [];
    if (!target.roles.cache.has(ECLIPSE_ROLE_ID_PROMO)) { adds.push(ECLIPSE_ROLE_ID_PROMO); changes.push(`+${eclipseRolePromo.name}`); }
    if (!target.roles.cache.has(ECLIPSE_ROLE_ID_BASE)) { adds.push(ECLIPSE_ROLE_ID_BASE); changes.push(`+${eclipseRoleBase.name}`); }
    if (target.roles.cache.has(TRIAL_ROLE_ID)) { removes.push(TRIAL_ROLE_ID); changes.push(`-${trialRole.name}`); }
    if (guestRole && target.roles.cache.has(GUEST_ROLE_ID)) { removes.push(GUEST_ROLE_ID); changes.push(`-${guestRole.name}`); }
  if (academyRole && !target.roles.cache.has(ACADEMY_ROLE_ID)) { adds.push(ACADEMY_ROLE_ID); changes.push(`+${academyRole.name}`); }
    if (!changes.length) return interaction.reply({ content: '⚠️ Nothing to change.', ephemeral: true });
    try { if (adds.length) await target.roles.add(adds, `Slash /eclp by ${interaction.user.tag}`); if (removes.length) await target.roles.remove(removes, `Slash /eclp by ${interaction.user.tag}`); }
    catch (err) { console.error('Slash /eclp error:', err); return interaction.reply({ content: '❌ Error applying roles.', ephemeral: true }); }
    const embed = new EmbedBuilder().setColor('#9B59B6').setDescription(`🌟 Promotion applied to ${target}: ${changes.join(', ')}`);
    await interaction.reply({ content: '🌟 Promotion done', ephemeral: true });
    sendPublicEmbed(embed);
    return;
  }
});

function buildRosterEmbed() {
  const embed = new EmbedBuilder()
    .setTitle("🌘 Eclipse Official Roster")
    .setColor("#9B59B6") // Purple theme instead of yellow
    .setTimestamp();

  for (const [role, members] of Object.entries(roster)) {
    if (members.length) {
      const listRaw = members.map(formatMember).join("\n");
      // Wrap in code block for dark background + copy button
      const codeWrapped = listRaw.length ? `\n\n\`\`\`\n${listRaw}\n\`\`\`` : '*Vacío*';
      embed.addFields({ name: `**${fancyCategoryName(role)}**`, value: codeWrapped, inline: false });
    } else {
      embed.addFields({ name: `**${fancyCategoryName(role)}**`, value: "*Vacío*", inline: false });
    }
  }
  // Add member count footer and GIF image
  const total = Object.values(roster).reduce((acc, arr) => acc + arr.length, 0);
  embed.setFooter({ text: `Member Count: ${total}` });
  embed.setImage('https://i.imgur.com/I2LPjko.gif');
  return embed;
}

async function updateRosterMessage(triggerMessage) {
  try {
    if (rosterMessageId && rosterChannelId) {
      const channel = await client.channels.fetch(rosterChannelId).catch(() => null);
      const msg = channel ? await channel.messages.fetch(rosterMessageId).catch(() => null) : null;
      if (msg) {
        await msg.edit({ embeds: [buildRosterEmbed()] });
        return;
      }
    }
    // Si no hay mensaje previo o no se pudo editar, enviar uno nuevo
  const channel = triggerMessage.channel;
    const sent = await channel.send({ embeds: [buildRosterEmbed()] });
    rosterMessageId = sent.id;
    rosterChannelId = sent.channel.id;
  } catch (err) {
    console.error("Error actualizando/creando mensaje de roster:", err);
  }
}

// ------------------------------------------------------
// Comando: !addcat <nombre> [posicion]
// ------------------------------------------------------
client.on('messageCreate', async (message) => {
  // ...existing code from tu ejemplo avanzado para +pass, +purge, +eclp, +help, etc...
  if (message.author.bot) return;
  const isRosterChannel = message.channel.id === ROSTER_CHANNEL_ID;

  // ------------------------------------------------------
  // Comando: !roster
  // ------------------------------------------------------
  if (message.content.toLowerCase().startsWith('!roster')) {
    // Muestra el roster actual en el canal
    await message.channel.send({ embeds: [buildRosterEmbed()] });
    return;
  }

  // ------------------------------------------------------
  // Comando: !help
  // ------------------------------------------------------
  if (message.content.toLowerCase().startsWith('!help')) {
    const helpText = `**Comandos disponibles:**\n\n` +
      `!roster - Muestra el roster actual\n` +
      `!addcat <nombre> [posicion] - Añade una categoría\n` +
      `!delcat <nombre> - Elimina una categoría\n` +
      `!editcat <viejo> <nuevo> - Renombra una categoría\n` +
      `\nTambién puedes usar los comandos con / (slash commands) si están habilitados.`;
    await message.channel.send({ embeds: [buildWarnEmbed(helpText)] });
    return;
  }

  // ------------------------------------------------------
  // Comando: +roster
  // ------------------------------------------------------
  if (message.content.toLowerCase().startsWith('+roster')) {
    await message.channel.send({ embeds: [buildRosterEmbed()] });
    return;
  }

  // ------------------------------------------------------
  // Comando: +help
  // ------------------------------------------------------
  if (message.content.toLowerCase().startsWith('+help')) {
    const helpText = `**Comandos disponibles:**\n\n` +
      `+roster - Muestra el roster actual\n` +
      `+help - Muestra esta ayuda\n` +
      `!addcat <nombre> [posicion] - Añade una categoría\n` +
      `!delcat <nombre> - Elimina una categoría\n` +
      `!editcat <viejo> <nuevo> - Renombra una categoría\n` +
      `\nTambién puedes usar los comandos con / (slash commands) si están habilitados.`;
    await message.channel.send({ embeds: [buildWarnEmbed(helpText)] });
    return;
  }
  // ------------------------------------------------------
  // Comando: !addcat <nombre>
  // ------------------------------------------------------
  if (message.content.toLowerCase().startsWith('!addcat ')) {
    if (!isRosterChannel) return replyWarnMessage(message, 'Category commands only allowed in the designated channel.');
    const parts = message.content.trim().split(/\s+/);
    if (parts.length < 2) return replyWarnMessage(message, 'Usage: !addcat <name> [position]');
    const catName = parts[1];
    let pos = parts.length > 2 ? parseInt(parts[2], 10) : null;
    if (isNaN(pos) || pos === null) pos = Object.keys(roster).length;
    if (roster[catName]) return replyWarnMessage(message, `Category '${catName}' already exists.`);
    const entries = Object.entries(roster);
    const newEntries = [
      ...entries.slice(0, pos),
      [catName, []],
      ...entries.slice(pos)
    ];
    roster = Object.fromEntries(newEntries);
    saveRoster();
    await updateRosterMessage(message);
    return message.channel.send({ embeds: [buildWarnEmbed(`✅ Category '${catName}' added at position ${pos + 1}.`)] });
  }

  // ------------------------------------------------------
  // Comando: !delcat <nombre>
  // ------------------------------------------------------
  if (message.content.toLowerCase().startsWith('!delcat ')) {
    const parts = message.content.trim().split(/\s+/);
    if (parts.length < 2) return replyWarnMessage(message, 'Usage: !delcat <name>');
    const frag = parts.slice(1).join(' ');
    const categories = Object.keys(roster);
    const lc = frag.toLowerCase();
    let match = categories.find(c => c.toLowerCase() === lc);
    if (!match) {
      const prefixMatches = categories.filter(c => c.toLowerCase().startsWith(lc));
      if (prefixMatches.length === 1) match = prefixMatches[0];
      else if (prefixMatches.length > 1) return replyWarnMessage(message, `Ambiguous fragment. Matches: ${prefixMatches.join(', ')}`);
      else {
        const includeMatches = categories.filter(c => c.toLowerCase().includes(lc));
        if (includeMatches.length === 1) match = includeMatches[0];
        else if (includeMatches.length > 1) return replyWarnMessage(message, `Ambiguous fragment. Matches: ${includeMatches.join(', ')}`);
      }
    }
    if (!match) return replyWarnMessage(message, `Category fragment '${frag}' does not match any category.`);
    delete roster[match];
    saveRoster();
    await updateRosterMessage(message);
    return message.channel.send({ embeds: [buildWarnEmbed(`🗑️ Category '${match}' and its members deleted.`)] });
  }

  // ------------------------------------------------------
  // Comando: !editcat <old> <new>
  // ------------------------------------------------------
  if (message.content.toLowerCase().startsWith('!editcat ')) {
    if (!isRosterChannel) return replyWarnMessage(message, 'Category commands only allowed in the designated channel.');
    const parts = message.content.trim().split(/\s+/);
    if (parts.length < 3) return replyWarnMessage(message, 'Usage: !editcat <oldName> <newName>');
    const frag = parts[1];
    const newName = parts.slice(2).join(' ');
    const categories = Object.keys(roster);
    const lc = frag.toLowerCase();
    let match = categories.find(c => c.toLowerCase() === lc);
    if (!match) {
      const prefixMatches = categories.filter(c => c.toLowerCase().startsWith(lc));
      if (prefixMatches.length === 1) match = prefixMatches[0];
      else if (prefixMatches.length > 1) return replyWarnMessage(message, `Ambiguous fragment. Matches: ${prefixMatches.join(', ')}`);
      else {
        const includeMatches = categories.filter(c => c.toLowerCase().includes(lc));
        if (includeMatches.length === 1) match = includeMatches[0];
        else if (includeMatches.length > 1) return replyWarnMessage(message, `Ambiguous fragment. Matches: ${includeMatches.join(', ')}`);
      }
    }
    if (!match) return replyWarnMessage(message, `Category fragment '${frag}' does not match any category.`);
    if (roster[newName]) return replyWarnMessage(message, `Category '${newName}' already exists.`);
    const entries = Object.entries(roster);
    const idx = entries.findIndex(([k]) => k === match);
  if (idx === -1) return replyWarnMessage(message, `Internal error: category not found.`);
    const newEntries = [
      ...entries.slice(0, idx),
      [newName, roster[match]],
      ...entries.slice(idx + 1)
    ];
    roster = Object.fromEntries(newEntries);
    saveRoster();
    await updateRosterMessage(message);
    return message.channel.send({ embeds: [buildWarnEmbed(`✏️ Category '${match}' renamed to '${newName}'.`)] });
  }

  try {
    // Siempre buscar el último mensaje de roster en el canal para editarlo
  const channel = message.channel;
    const messages = await channel.messages.fetch({ limit: 10 });
    const rosterMsg = messages.find(m => m.author.id === client.user.id && m.embeds.length && m.embeds[0].title && m.embeds[0].title.includes('Eclipse Official Roster'));
    if (rosterMsg) {
      await rosterMsg.edit({ embeds: [buildRosterEmbed()] });
      rosterMessageId = rosterMsg.id;
      rosterChannelId = rosterMsg.channel.id;
    } else {
      const sent = await channel.send({ embeds: [buildRosterEmbed()] });
      rosterMessageId = sent.id;
      rosterChannelId = sent.channel.id;
    }
  } catch (err) {
    console.error("Error actualizando/creando mensaje de roster:", err);
  }
});

// Token desde variable de entorno (regenera el tuyo y NO lo subas al código)
if (!process.env.DISCORD_TOKEN) {
  console.error("❌ Falta DISCORD_TOKEN en variables de entorno.");
  console.error("🔎 Soluciones rápidas:");
  console.error("  1) PowerShell (solo esta sesión):  $env:DISCORD_TOKEN=\"TU_TOKEN\"; node index.js");
  console.error("  2) Permanente: setx DISCORD_TOKEN \"TU_TOKEN\"  (luego CERRAR y abrir nueva terminal)");
  console.error("  3) Archivo .env: crear .env con: DISCORD_TOKEN=TU_TOKEN  e instalar dotenv -> npm i dotenv");
} else {
  console.log("🔐 Token cargado (longitud:", process.env.DISCORD_TOKEN.length, ")");
  client.login(process.env.DISCORD_TOKEN).catch(err => {
    console.error("❌ Error al iniciar sesión. Asegúrate de que el token es válido y no regenerado.", err);
  });
}