require('dotenv').config();

const Discord = require('discord.js');
const mongoose = require('mongoose');

const Claim = require('./Claim.js');

const client = new Discord.Client({
	intents: ['GUILDS'],
});

client.once('ready', async () => {
	for (const guild of [...client.guilds.cache.values()]) {
		const claims = await Claim.find({guildId: guild.id}).exec();
		for (const claim of claims) {
			try {
				const member = await guild.members.fetch(claim.discordId);
				if (member && guild.ownerId !== member.id) {
					let baseName;
					const match = /^(.+)⭐\s*(?:[0-9]+|\?)$/.exec(member.displayName);
					if (match) {
						baseName = match[1].trim();
					} else {
						baseName = member.displayName;
					}
					await member.setNickname(baseName);
				}
			} catch (err) {
				console.log(err);
			}
		}
	}
	process.exit(0);
});

mongoose.connect(process.env.DATABASE, {useNewUrlParser: true, useUnifiedTopology: true}).then(() => client.login(process.env.BOT_TOKEN)).catch(err => {
	console.error(err);
	process.exit(1);
});
