// config.js - Configuración centralizada (valores por defecto)
// Para cambiar IDs en el nuevo servidor, edita el archivo .env

module.exports = {
  // IDs de canales
  ROSTER_CHANNEL_ID: process.env.ROSTER_CHANNEL_ID || '1373410183853772849',

  // IDs de roles
  ROLES: {
    ECLIPSE_BASE: process.env.ROLE_ECLIPSE_BASE || '1373410183312703568',
    ECLIPSE_PROMO: process.env.ROLE_ECLIPSE_PROMO || '1373410183312703570',
    TRIAL: process.env.ROLE_TRIAL || '1373410183312703569',
    ACADEMY: process.env.ROLE_ACADEMY || '1388667580407087154',
    GUEST: process.env.ROLE_GUEST || '1373410183249920113',
  },

  // IDs de roles permitidos para comandos especiales
  ALLOWED_ROLE_IDS: (process.env.ALLOWED_ROLE_IDS || '1373410183333679152,1373410183333679151').split(','),
};
