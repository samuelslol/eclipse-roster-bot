// config.js - Configuración centralizada (valores por defecto)
// Para cambiar IDs en el nuevo servidor, edita el archivo .env

module.exports = {
  // IDs de canales
  ROSTER_CHANNEL_ID: process.env.ROSTER_CHANNEL_ID || '1516577666336030801',

  // IDs de roles
  ROLES: {
    ECLIPSE: process.env.ROLE_ECLIPSE || '1516567986163683430',
    MEMBER: process.env.ROLE_MEMBER || '1487901133136461855',
    GUEST: process.env.ROLE_GUEST || '1487881657628364981',
  },

  // IDs de roles permitidos para comandos especiales (+help)
  ALLOWED_ROLE_IDS: (process.env.ALLOWED_ROLE_IDS || '1488043849430601728,1490566406041899049').split(','),
};
