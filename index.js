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
  // Registro de slash commands
  const guildId = process.env.GUILD_ID; // Añade en .env si quieres registro rápido
  const guildCommands = [
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
    },
    {
      name: 'hola',
      description: 'Saluda con el bot'
    }
  ];
  const globalCommands = [
    { name: 'hola', description: 'Saluda con el bot' }
  ];
  if (guildId) {
    try {
      await client.application.commands.set(guildCommands, guildId);
      console.log(`🛠️ Slash commands registrados en guild ${guildId}`);
    } catch (err) {
      console.error('❌ Error registrando slash commands guild:', err);
    }
  } else {
    console.log('ℹ️ GUILD_ID no definido; omitiendo registro de slash commands guild. Añade GUILD_ID en .env para registro inmediato.');
  }
  try {
    await client.application.commands.set(globalCommands);
    console.log('🌐 Slash commands globales registrados.');
  } catch (err) {
    console.error('❌ Error registrando slash commands globales:', err);
  }
});

// ------------------------------------------------------
// Handler de slash commands (ephemeral support)
// ------------------------------------------------------
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const adminCheck = () => interaction.memberPermissions?.has(PermissionsBitField.Flags.Administrator);

  const sendPublicEmbed = (embed) => interaction.channel?.send({ embeds: [embed] }).catch(()=>{});

  if (interaction.commandName === 'hola') {
    return interaction.reply({ content: '¡Hola! 👋', ephemeral: true });
  }

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
    const sent = await triggerMessage.channel.send({ embeds: [buildRosterEmbed()] });
    rosterMessageId = sent.id;
    rosterChannelId = sent.channel.id;
  } catch (err) {
    console.error("Error actualizando/creando mensaje de roster:", err);
  }
}

client.on("messageCreate", async (message) => {
  if (message.author.bot) return;
  // Solo permitir comandos de roster en canal específico
  const ROSTER_CHANNEL_ID = '1373410183853772849';
  const isRosterChannel = message.channel.id === ROSTER_CHANNEL_ID;

  // ------------------------------------------------------
  // Comando de roles: +pass @usuario
  // Acciones: +Eclipse, -Guest, +Trial
  // Solo administradores.
  // ------------------------------------------------------
  if (message.content.toLowerCase().startsWith("+pass")) {
    // Eliminar restricción de canal para +pass
    if (!message.member?.permissions?.has(PermissionsBitField.Flags.Administrator)) {
      return replyWarnMessage(message, 'You lack Administrator permission.');
    }
    const ECLIPSE_ROLE_ID = '1373410183312703568';
    const GUEST_ROLE_ID   = '1373410183249920113';
    const TRIAL_ROLE_ID   = '1373410183312703569';

    // Obtener target: mención o fragmento de nombre
    let target = message.mentions.members?.first();
    if (!target) {
      const parts = message.content.trim().split(/\s+/).slice(1); // quitar comando
      if (!parts.length) return replyWarnMessage(message, 'Usage: +pass @user OR +pass partialName');
      const queryRaw = parts.join(' ');
      try { await message.guild.members.fetch(); } catch(_) {}
      const res = smartFindMember(message.guild, queryRaw);
      if (res.status === 'none') return replyWarnMessage(message, `No user found matching "${queryRaw}"`);
      if (res.status === 'multi') {
        const sample = [...res.matches.values()].slice(0,5).map(m=>m.user.tag).join(', ');
        return replyWarnMessage(message, `Multiple matches (${res.matches.size}). Be more specific. Examples: ${sample}`);
      }
      target = res.member;
    }

    // Verificar que el bot tiene permisos
    if (!message.guild.members.me.permissions.has(PermissionsBitField.Flags.ManageRoles)) {
      return replyWarnMessage(message, 'Bot lacks Manage Roles permission.');
    }

    const roleAddIds = [];
    const roleRemoveIds = [];
    const changes = [];

    const eclipseRole = message.guild.roles.cache.get(ECLIPSE_ROLE_ID);
    const guestRole   = message.guild.roles.cache.get(GUEST_ROLE_ID);
    const trialRole   = message.guild.roles.cache.get(TRIAL_ROLE_ID);

    if (!eclipseRole || !guestRole || !trialRole) {
      return replyWarnMessage(message, 'One or more role IDs are invalid (check code).');
    }

    // Evitar intentar asignar roles por encima del bot
    const botHighest = message.guild.members.me.roles.highest.position;
    for (const r of [eclipseRole, guestRole, trialRole]) {
      if (r.position >= botHighest) {
        return replyWarnMessage(message, `Role ${r.name} is above (or equal to) my highest role.`);
      }
    }

    // Añadir Eclipse
    if (!target.roles.cache.has(ECLIPSE_ROLE_ID)) {
      roleAddIds.push(ECLIPSE_ROLE_ID);
      changes.push(`+${eclipseRole.name}`);
    }
    // Añadir Trial
    if (!target.roles.cache.has(TRIAL_ROLE_ID)) {
      roleAddIds.push(TRIAL_ROLE_ID);
      changes.push(`+${trialRole.name}`);
    }
    // Remover Guest
    if (target.roles.cache.has(GUEST_ROLE_ID)) {
      roleRemoveIds.push(GUEST_ROLE_ID);
      changes.push(`-${guestRole.name}`);
    }

    if (!changes.length) {
      try { await message.react('⚠️'); } catch (_) {}
      return replyWarnMessage(message, 'No changes to apply for that user.', { deleteMs: 4000 });
    }

    try {
      if (roleAddIds.length) await target.roles.add(roleAddIds, `+pass por ${message.author.tag}`);
      if (roleRemoveIds.length) await target.roles.remove(roleRemoveIds, `+pass por ${message.author.tag}`);
    } catch (err) {
      console.error("Error modificando roles:", err);
      return replyWarnMessage(message, 'Error applying role changes (see console).');
    }

    const embedResponse = new EmbedBuilder()
      .setColor("#FFA500")
      .setDescription(`✅ Changed roles for ${target}: ${changes.join(', ')}`);

    try { await message.react('✅'); } catch (_) {}
    message.channel.send({ embeds: [embedResponse] }).catch(()=>{});
    return; // No continuar con otros handlers
  }

  // ------------------------------------------------------
  // Comando de roles: +purge @usuario
  // Remueve roles Eclipse (2 IDs), Trial y Academy, asigna Guest
  // Solo administradores.
  // ------------------------------------------------------
  if (message.content.toLowerCase().startsWith("+purge")) {
    // Eliminar restricción de canal para +purge
    if (!message.member?.permissions?.has(PermissionsBitField.Flags.Administrator)) {
      return replyWarnMessage(message, 'You lack Administrator permission.');
    }
  const ECLIPSE_ROLE_IDS = ['1373410183312703570','1373410183312703568'];
  const TRIAL_ROLE_ID    = '1373410183312703569';
  const ACADEMY_ROLE_ID  = '1388667580407087154';
  const GUEST_ROLE_ID    = '1373410183249920113';

    let target = message.mentions.members?.first();
    if (!target) {
      const parts = message.content.trim().split(/\s+/).slice(1);
      if (!parts.length) return replyWarnMessage(message, 'Usage: +purge @user OR +purge partialName');
      const queryRaw = parts.join(' ');
      try { await message.guild.members.fetch(); } catch(_) {}
      const res = smartFindMember(message.guild, queryRaw);
      if (res.status === 'none') return replyWarnMessage(message, `No user found matching "${queryRaw}"`);
      if (res.status === 'multi') {
        const sample = [...res.matches.values()].slice(0,5).map(m=>m.user.tag).join(', ');
        return replyWarnMessage(message, `Multiple matches (${res.matches.size}). Be more specific. Examples: ${sample}`);
      }
      target = res.member;
    }
    if (!message.guild.members.me.permissions.has(PermissionsBitField.Flags.ManageRoles)) {
      return replyWarnMessage(message, 'Bot lacks Manage Roles permission.');
    }

    const guestRole = message.guild.roles.cache.get(GUEST_ROLE_ID);
    if (!guestRole) {
      return replyWarnMessage(message, 'Guest role not found (check ID).');
    }

    const toRemove = [];
    const changes = [];

    for (const rid of ECLIPSE_ROLE_IDS) {
      if (target.roles.cache.has(rid)) {
        toRemove.push(rid);
      }
    }
    if (target.roles.cache.has(TRIAL_ROLE_ID)) {
      toRemove.push(TRIAL_ROLE_ID);
    }
    if (target.roles.cache.has(ACADEMY_ROLE_ID)) {
      toRemove.push(ACADEMY_ROLE_ID);
    }

    // Ordenar para evitar duplicados accidentales
    const uniqueRemove = [...new Set(toRemove)];

    // Quitar roles
    try {
      if (uniqueRemove.length) {
        await target.roles.remove(uniqueRemove, `+purge por ${message.author.tag}`);
        const removedNames = uniqueRemove.map(id => message.guild.roles.cache.get(id)?.name || id);
        for (const rn of removedNames) changes.push(`-${rn}`);
      }
    } catch (err) {
      console.error("Error removiendo roles en +purge:", err);
      return replyWarnMessage(message, 'Error removing roles (see console).');
    }

    // Añadir Guest si no lo tiene
    if (!target.roles.cache.has(GUEST_ROLE_ID)) {
      try {
        await target.roles.add(GUEST_ROLE_ID, `+purge por ${message.author.tag}`);
        changes.push(`+${guestRole.name}`);
      } catch (err) {
        console.error("Error añadiendo Guest en +purge:", err);
        return replyWarnMessage(message, 'Error assigning Guest role.');
      }
    }

    // Resetear nickname si tiene uno distinto al username
    const hadNickname = !!target.nickname;
    if (hadNickname) {
      // Verificar permiso para cambiar apodos
      if (message.guild.members.me.permissions.has(PermissionsBitField.Flags.ManageNicknames)) {
        try {
          await target.setNickname(null, `Reset por +purge (${message.author.tag})`);
          changes.push(`reset-nick`);
        } catch (err) {
          if (err.code === 50013) {
            // Permisos insuficientes, mostrar advertencia al usuario
            message.channel.send({ embeds: [buildWarnEmbed('No se pudo resetear el nickname: faltan permisos de Manage Nicknames.')] });
          } else {
            console.warn("No se pudo resetear nickname en +purge:", err);
          }
        }
      } else {
        message.channel.send({ embeds: [buildWarnEmbed('El bot no tiene permisos para cambiar apodos (Manage Nicknames).')] });
      }
    }

    if (!changes.length) {
      try { await message.react('❌'); } catch(_) {}
      const noChangeEmbed = buildWarnEmbed('Nothing to purge: no roles removed and Guest already present.');
      message.channel.send({ embeds: [noChangeEmbed] }).catch(()=>{});
      return; 
    }

    const purgeEmbed = new EmbedBuilder()
      .setColor('#E74C3C') // rojo
      .setDescription(`🧹 Purged roles for ${target}: ${changes.join(', ')}`);
    try { await message.react('🧹'); } catch(_) {}
    message.channel.send({ embeds: [purgeEmbed] }).catch(()=>{});
    return;
  }

  // ------------------------------------------------------
  // Comando de roles: +eclp @usuario | +eclp parteDelNombre
  // Promueve: quita Trial y pone Eclipse (ID específico 1373410183312703570)
  // Solo administradores (igual que +pass)
  // ------------------------------------------------------
  if (message.content.toLowerCase().startsWith('+eclp')) {
    // Eliminar restricción de canal para +eclp
    if (!message.member?.permissions?.has(PermissionsBitField.Flags.Administrator)) {
      return replyWarnMessage(message, 'You lack Administrator permission.');
    }
    const ECLIPSE_ROLE_ID_PROMO = '1373410183312703570';
    const ECLIPSE_ROLE_ID_BASE = '1373410183312703568'; // ensure base role also present
    const GUEST_ROLE_ID = '1373410183249920113'; // remove Guest if present
    const TRIAL_ROLE_ID = '1373410183312703569';
  const ACADEMY_ROLE_ID = '1388667580407087154'; // also add Academy role on promotion

    let target = message.mentions.members?.first();
    if (!target) {
      const parts = message.content.trim().split(/\s+/).slice(1);
      if (!parts.length) return replyWarnMessage(message, 'Usage: +eclp @user OR +eclp partialName');
      const queryRaw = parts.join(' ');
      try { await message.guild.members.fetch(); } catch(_) {}
      const res = smartFindMember(message.guild, queryRaw);
      if (res.status === 'none') return replyWarnMessage(message, `No user found matching "${queryRaw}"`);
      if (res.status === 'multi') {
        const sample = [...res.matches.values()].slice(0,5).map(m=>m.user.tag).join(', ');
        return replyWarnMessage(message, `Multiple matches (${res.matches.size}). Be more specific. Examples: ${sample}`);
      }
      target = res.member;
    }

    if (!message.guild.members.me.permissions.has(PermissionsBitField.Flags.ManageRoles)) {
      return replyWarnMessage(message, 'Bot lacks Manage Roles permission.');
    }

    const eclipseRolePromo = message.guild.roles.cache.get(ECLIPSE_ROLE_ID_PROMO);
    const eclipseRoleBase = message.guild.roles.cache.get(ECLIPSE_ROLE_ID_BASE);
    const guestRole = message.guild.roles.cache.get(GUEST_ROLE_ID);
    const trialRole = message.guild.roles.cache.get(TRIAL_ROLE_ID);
    const academyRole = message.guild.roles.cache.get(ACADEMY_ROLE_ID);
    if (!eclipseRolePromo || !eclipseRoleBase || !trialRole) {
      return replyWarnMessage(message, 'One or more role IDs invalid (Eclipse base/promo or Trial).');
    }

    const botHighest = message.guild.members.me.roles.highest.position;
    for (const r of [eclipseRolePromo, eclipseRoleBase, trialRole, guestRole, academyRole]) {
      if (r && r.position >= botHighest) {
        return replyWarnMessage(message, `Role ${r.name} is above (or equal to) my highest role.`);
      }
    }

    const adds = [];
    const removes = [];
    const changes = [];

    if (!target.roles.cache.has(ECLIPSE_ROLE_ID_PROMO)) {
      adds.push(ECLIPSE_ROLE_ID_PROMO);
      changes.push(`+${eclipseRolePromo.name}`);
    }
    if (!target.roles.cache.has(ECLIPSE_ROLE_ID_BASE)) {
      adds.push(ECLIPSE_ROLE_ID_BASE);
      changes.push(`+${eclipseRoleBase.name}`);
    }
    if (target.roles.cache.has(TRIAL_ROLE_ID)) {
      removes.push(TRIAL_ROLE_ID);
      changes.push(`-${trialRole.name}`);
    }
    if (guestRole && target.roles.cache.has(GUEST_ROLE_ID)) {
      removes.push(GUEST_ROLE_ID);
      changes.push(`-${guestRole.name}`);
    }
    if (academyRole && !target.roles.cache.has(ACADEMY_ROLE_ID)) {
      adds.push(ACADEMY_ROLE_ID);
      changes.push(`+${academyRole.name}`);
    }

    if (!changes.length) {
      try { await message.react('⚠️'); } catch(_) {}
      return replyWarnMessage(message, 'Nothing to change: already Eclipse or lacks Trial.', { deleteMs: 4000 });
    }

    try {
      if (adds.length) await target.roles.add(adds, `+eclp por ${message.author.tag}`);
      if (removes.length) await target.roles.remove(removes, `+eclp por ${message.author.tag}`);
    } catch (err) {
      console.error('Error en +eclp:', err);
      return replyWarnMessage(message, 'Error applying role changes (see console).');
    }

    const promoEmbed = new EmbedBuilder()
      .setColor('#9B59B6')
      .setDescription(`🌟 Promotion applied to ${target}: ${changes.join(', ')}`);
    try { await message.react('🌟'); } catch(_) {}
    message.channel.send({ embeds: [promoEmbed] }).catch(()=>{});
    return;
  }

  // ------------------------------------------------------
  // Cambiar estilo: +estilo <nombre>  (alias: +estilos)
  // ------------------------------------------------------
  if (message.content.toLowerCase().startsWith('+estilo') || message.content.toLowerCase().startsWith('+styles')) {
    if (!isRosterChannel) return replyWarnMessage(message, 'Roster commands only allowed in the designated channel.');
    const parts = message.content.trim().split(/\s+/);
    if (parts.length < 2) {
      return message.channel.send({ embeds: [buildWarnEmbed(`Available styles: ${Object.keys(memberStyles).join(', ')} | Usage: +estilo name (alias: +styles name)`)] });
    }
    const style = parts[1].toLowerCase();
    if (!memberStyles[style]) {
      return message.channel.send({ embeds: [buildWarnEmbed(`Invalid style. Use one of: ${Object.keys(memberStyles).join(', ')}`)] });
    }
    currentStyleKey = style;
    try { await message.react('🎨'); } catch (_) {}
    await updateRosterMessage(message);
    setTimeout(() => { message.delete().catch(() => {}); }, 800);
    return;
  }

  // ------------------------------------------------------
  // Ayuda: +help
  // ------------------------------------------------------
  if (message.content.toLowerCase() === '+help') {
    if (!isRosterChannel) return replyWarnMessage(message, 'Roster commands only allowed in the designated channel.');
    const ALLOWED_ROLE_IDS = ['1373410183333679152','1373410183333679151']; // unique list provided
    const isAdmin = message.member?.permissions?.has(PermissionsBitField.Flags.Administrator);
    const hasAllowedRole = message.member?.roles?.cache?.some(r => ALLOWED_ROLE_IDS.includes(r.id));
    if (!isAdmin && !hasAllowedRole) {
      return replyWarnMessage(message, 'Help command restricted: need Administrator or required role.');
    }
    const helpEmbed = new EmbedBuilder()
      .setTitle('📋 Roster Commands')
      .setColor('#00FF00')
      .setDescription('Editable roster management:')
      .addFields(
        { name: '`+name category`', value: 'Add member (category can be partial). Ex: `+Shamu ecli` -> Eclipse' },
        { name: '`+category name`', value: 'Inverse order also works. Ex: `+tri Atlas` -> Trial' },
        { name: '`-name`', value: 'Remove member. Ex: `-Camsita`' },
        { name: '`!roster`', value: 'Create or refresh roster message' },
        { name: '`+estilo name`', value: 'Change style. Ex: +estilo sparkle' },
        { name: 'Styles', value: Object.keys(memberStyles).join(', ') },
        { name: 'Categories', value: 'Council, Staff, Moderador, Eclipse, Trial (partials ok: coun, sta, mod, ecli, tri)' }
      );
    message.channel.send({ embeds: [helpEmbed] });
    return;
  }

  // Añadir miembro: +nombre categoría
  if (message.content.startsWith("+")) {
    if (!isRosterChannel) return replyWarnMessage(message, 'Roster commands only allowed in the designated channel.');
    const args = message.content.slice(1).trim().split(/\s+/);
    if (args.length < 2) {
      message.channel.send({ embeds: [buildWarnEmbed('Usage: +name category OR +category name. Category can be partial (ecli, tri, coun, sta, mod).')] });
      return;
    }
    let role = null;
    let name = null;
    // Strategy: try last token as category fragment first
    const lastToken = args[args.length - 1];
    const lastRes = resolveCategoryFragment(lastToken);
    if (lastRes.status === 'ok') {
      role = lastRes.category;
      name = args.slice(0, -1).join(' ');
    } else if (lastRes.status === 'ambiguous') {
      return message.channel.send({ embeds: [buildWarnEmbed(`Ambiguous category fragment '${lastToken}'. Matches: ${lastRes.matches.join(', ')}`)] });
    } else {
      // Try first token
      const firstToken = args[0];
      const firstRes = resolveCategoryFragment(firstToken);
      if (firstRes.status === 'ok') {
        role = firstRes.category;
        name = args.slice(1).join(' ');
      } else if (firstRes.status === 'ambiguous') {
        return message.channel.send({ embeds: [buildWarnEmbed(`Ambiguous category fragment '${firstToken}'. Matches: ${firstRes.matches.join(', ')}`)] });
      }
    }

    if (!role) {
      return message.channel.send({ embeds: [buildWarnEmbed('Invalid or missing category fragment. Try: coun, sta, mod, ecli, tri.')] });
    }

    // Normalizar nombre a Title Case
    name = name.trim();
    if (!name.length) {
      message.channel.send({ embeds: [buildWarnEmbed('Empty name.')] });
      return;
    }
    if (name.length > 32) {
      message.channel.send({ embeds: [buildWarnEmbed('Name too long (max 32 chars).')] });
      return;
    }
    const displayName = normalizeDisplayName(name);
    const lowerName = displayName.toLowerCase();
    let previousRole = null;
    for (const r in roster) {
      const idx = roster[r].findIndex(n => n.toLowerCase() === lowerName);
      if (idx !== -1) {
        previousRole = r;
        // Si ya está en la misma categoría, nada que hacer
        if (r === role) {
          try { await message.react('⚠️'); } catch (_) {}
          setTimeout(() => { message.delete().catch(() => {}); }, 500);
          return;
        }
        // Remover de la categoría anterior
        roster[r].splice(idx, 1);
        break;
      }
    }

    // Añadir a la nueva categoría
    roster[role].push(displayName);
    roster[role].sort((a,b) => a.localeCompare(b, 'es', { sensitivity: 'base' }));
    if (previousRole) {
      // Reordenar la anterior también por prolijidad
      roster[previousRole].sort((a,b) => a.localeCompare(b, 'es', { sensitivity: 'base' }));
    }

    // Reacción distinta si fue movimiento
    const reaction = previousRole ? '🔁' : '✅';
    try { await message.react(reaction); } catch (_) { /* ignorar */ }
    await updateRosterMessage(message);
      saveRoster();
    setTimeout(() => { message.delete().catch(() => {}); }, 500);
    return;
  }

  // Eliminar miembro: -nombre
  if (message.content.startsWith("-")) {
    if (!isRosterChannel) return replyWarnMessage(message, 'Roster commands only allowed in the designated channel.');
    let rawName = message.content.slice(1).trim();
    if (!rawName) {
      message.channel.send({ embeds: [buildWarnEmbed('Usage: -name OR -category name')] });
      return;
    }
    // Permitir formato "-staff maria" o "-Staff Maria"
    const tokens = rawName.split(/\s+/);
    const possibleCategory = tokens[0].charAt(0).toUpperCase() + tokens[0].slice(1).toLowerCase();
    if (roster[possibleCategory] && tokens.length > 1) {
      // Ignorar la categoría para la búsqueda; quedarnos con el resto como nombre real
      rawName = tokens.slice(1).join(' ');
    }
    const searchLower = rawName.toLowerCase();
    let found = false;
    for (const role in roster) {
      const idx = roster[role].findIndex(n => n.toLowerCase() === searchLower);
      if (idx !== -1) {
        roster[role].splice(idx, 1);
        found = true;
        try { await message.react('❌'); } catch (_) { /* ignorar */ }
        await updateRosterMessage(message);
          saveRoster();
        setTimeout(() => { message.delete().catch(() => {}); }, 500);
        break;
      }
    }
    if (!found) {
      message.channel.send({ embeds: [buildWarnEmbed(`${normalizeDisplayName(rawName)} not found in roster.`)] });
    }
    return;
  }

  // Crear o refrescar el mensaje central del roster
  if (message.content.toLowerCase() === "!roster") {
    if (!isRosterChannel) return replyWarnMessage(message, 'Roster commands only allowed in the designated channel.');
    await updateRosterMessage(message);
    return;
  }

  // ------------------------------------------------------
  // Comando: !addcat <nombre>
  // Agrega una nueva categoría vacía
  // ------------------------------------------------------
  if (message.content.toLowerCase().startsWith('!addcat ')) {
    if (!isRosterChannel) return replyWarnMessage(message, 'Category commands only allowed in the designated channel.');
    const parts = message.content.trim().split(/\s+/);
    if (parts.length < 2) return replyWarnMessage(message, 'Usage: !addcat <name> [position]');
    // Si hay más de 2 partes y la última es un número, se toma como posición
    let pos = null;
    let catName = null;
    if (parts.length > 2 && /^\d+$/.test(parts[parts.length - 1])) {
      pos = parseInt(parts[parts.length - 1], 10);
      catName = parts.slice(1, -1).join(' ');
    } else {
      catName = parts.slice(1).join(' ');
    }
    if (roster[catName]) return replyWarnMessage(message, `Category '${catName}' already exists.`);
    // Insertar en la posición indicada o al final
    const entries = Object.entries(roster);
    let newEntries;
    if (pos !== null && pos > 0 && pos <= entries.length + 1) {
      // Insertar en el índice (pos-1)
      newEntries = [
        ...entries.slice(0, pos - 1),
        [catName, []],
        ...entries.slice(pos - 1)
      ];
    } else {
      // Al final
      newEntries = [...entries, [catName, []]];
    }
    roster = Object.fromEntries(newEntries);
    saveRoster();
    await updateRosterMessage(message);
    return message.channel.send({ embeds: [buildWarnEmbed(`✅ Category '${catName}' added${pos !== null ? ` at position ${pos}` : ''}.`)] });
  }

  // ------------------------------------------------------
  // Comando: !delcat <nombre>
  // Elimina una categoría y todos sus miembros
  // ------------------------------------------------------
  if (message.content.toLowerCase().startsWith('!delcat ')) {
    if (!isRosterChannel) return replyWarnMessage(message, 'Category commands only allowed in the designated channel.');
    const parts = message.content.trim().split(/\s+/);
    if (parts.length < 2) return replyWarnMessage(message, 'Usage: !delcat <name>');
    const frag = parts.slice(1).join(' ');
    // Buscar categoría por fragmento (no estricto)
    const categories = Object.keys(roster);
    const lc = frag.toLowerCase();
    let match = categories.find(c => c.toLowerCase() === lc);
    if (!match) {
      // Buscar por prefix
      const prefixMatches = categories.filter(c => c.toLowerCase().startsWith(lc));
      if (prefixMatches.length === 1) match = prefixMatches[0];
      else if (prefixMatches.length > 1) return replyWarnMessage(message, `Ambiguous fragment. Matches: ${prefixMatches.join(', ')}`);
      else {
        // Buscar por includes
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
  // Renombra una categoría (mantiene los miembros)
  // ------------------------------------------------------
  if (message.content.toLowerCase().startsWith('!editcat ')) {
    if (!isRosterChannel) return replyWarnMessage(message, 'Category commands only allowed in the designated channel.');
    const parts = message.content.trim().split(/\s+/);
    if (parts.length < 3) return replyWarnMessage(message, 'Usage: !editcat <oldName> <newName>');
    const frag = parts[1];
    const newName = parts.slice(2).join(' ');
    // Buscar categoría por fragmento (no estricto)
    const categories = Object.keys(roster);
    const lc = frag.toLowerCase();
    let match = categories.find(c => c.toLowerCase() === lc);
    if (!match) {
      // Buscar por prefix
      const prefixMatches = categories.filter(c => c.toLowerCase().startsWith(lc));
      if (prefixMatches.length === 1) match = prefixMatches[0];
      else if (prefixMatches.length > 1) return replyWarnMessage(message, `Ambiguous fragment. Matches: ${prefixMatches.join(', ')}`);
      else {
        // Buscar por includes
        const includeMatches = categories.filter(c => c.toLowerCase().includes(lc));
        if (includeMatches.length === 1) match = includeMatches[0];
        else if (includeMatches.length > 1) return replyWarnMessage(message, `Ambiguous fragment. Matches: ${includeMatches.join(', ')}`);
      }
    }
    if (!match) return replyWarnMessage(message, `Category fragment '${frag}' does not match any category.`);
    if (roster[newName]) return replyWarnMessage(message, `Category '${newName}' already exists.`);
    // Mantener el orden original
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

  // (Removed old !estilo and !help handlers)
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