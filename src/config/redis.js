// PEREVIOUS CODE -- COMMENTED OUT
// BY ANKIT
// module.exports = {
//   redisAuth: process.env.REDIS_AUTH
// }

// -- NEW

// module.exports = {

//   redisHost: process.env.REDIS_HOST || 'localhost',
//   redisPort: process.env.REDIS_PORT || 6379,
//   redisPassword: process.env.REDIS_PASSWORD || null
// }


// host: 'localhost', // or your Redis server IP
//   port: 6379,        // or your custom port
//   password: 'yourpassword', // if Redis requires a password


// redisAuth.js

// Load environment variables from .env file (if you're using dotenv)
require('dotenv').config();

// Fetch Redis authentication details from environment variables
const redisAuth = process.env.REDIS_AUTH;
// const redisHost = process.env.REDIS_HOST || 'localhost';
// const redisPort = process.env.REDIS_PORT || 6379;

// Export the configuration
module.exports = {
    redisAuth,
    
};
