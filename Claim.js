const mongoose = require('mongoose');

const schema = mongoose.Schema({
	guildId: String,
	discordId: String,
	aocId: String,
});

module.exports = mongoose.model('Claim', schema, 'claims');
