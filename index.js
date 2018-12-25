require('dotenv').config();

const cron = require('cron');
const Discord = require('discord.js');
const got = require('got');
const mongoose = require('mongoose');

const Claim = require('./Claim.js');

const client = new Discord.Client();

let leaderboard = new Map();

client.once('ready', async () => {
	await update();
	await client.user.setActivity('aoc claim AOC_USER_ID');

	// regularly get leaderboard data
	cron.job('0 */10 5 1-25 12 *', update, null, true, 'UTC'); // every 10 minutes for the first hour after unlock
	cron.job('0 */15 1-4,6-23 1-25 12 *', update, null, true, 'UTC'); // every 15 minutes for the rest of the day
	cron.job('0 */15 * 26-31 12 *', update, null, true, 'UTC'); // after the last unlock, only every 15 minutes
});

client.on('message', async (message) => {
	try {
		switch (true) {
			case message.content.startsWith('aoc claim'): {
				const aocId = message.content.slice('aoc claim'.length).trim();
				if (!/^[0-9]+$/.test(aocId)) {
					return message.reply('invalid ID.');
				}
				const exisiting = await Claim.findOne({guildId: message.guild.id, $or: [{discordId: message.author.id}, {aocId: aocId}]}).exec();
				if (exisiting) {
					if (exisiting.aocId === aocId) {
						return message.reply('this AoC account has already been claimed.');
					}
					if (exisiting.discordId === message.author.id) {
						return message.reply('you have already claimed an AoC account.');
					}
				}
				const claim = new Claim({guildId: message.guild.id, discordId: message.author.id, aocId});
				await claim.save();
				await updateNickname(message.guild, aocId);
				await message.reply('AoC account successfully claimed.');
				break;
			}

			case message.content.startsWith('aoc unclaim'): {
				const claim = await Claim.findOne({guildId: message.guild.id, discordId: message.author.id}).exec();
				if (!claim) {
					return message.reply('you haven\'t claimed an AoC account yet.');
				}
				const aocId = claim.aocId;
				await resetNickname(message.guild, aocId);
				await claim.delete();
				await message.reply('AoC account successfully unclaimed.');
				break;
			}

			case message.content.startsWith('aoc verify'): {
				const userStr = message.content.slice('aoc verify'.length).trim();
				const userMatch = /^<@!?(\d+)>$|^(\d+)$/.exec(userStr);
				if (!userMatch) {
					return message.reply('please provide a user mention or user ID.');
				}
				const discordId = userMatch[1] || userMatch[2];
				const claim = await Claim.findOne({guildId: message.guild.id, discordId}).exec();
				await message.guild.fetchMembers();
				const member = message.guild.member(discordId);
				if (!claim || !member) {
					return message.reply('❌');
				}
				const starMatch = /^.+⭐\s*(\d+|\?)$/.exec(member.displayName);
				if (!starMatch) {
					return message.reply('❌');
				}
				const nicknameStars = Number(starMatch[1]) || '?';
				if (nicknameStars === (leaderboard.get(claim.aocId) || '?')) {
					return message.reply('✅');
				} else {
					return message.reply('❌');
				}
			}
		}
	} catch (err) {
		console.error(err);
	}
});

mongoose.connect(process.env.DATABASE, {useNewUrlParser: true}).then(() => client.login(process.env.BOT_TOKEN)).catch(err => {
	console.error(err);
	process.exit(1);
});

/* functions */

async function update() {
	let newLeaderboard;
	try {
		newLeaderboard = await fetchLeaderboard();
	} catch (err) {
		console.log(err);
	}
	const usersToUpdate = new Set(leaderboard.keys());
	for (const key of newLeaderboard.keys()) {
		usersToUpdate.add(key);
	}
	leaderboard = newLeaderboard;
	for (const guild of client.guilds.array()) {
		await guild.fetchMembers();
		for (const user of usersToUpdate.values()) {
			try {
				await updateNickname(guild, user);
			} catch (err) {
				console.log(err);
			}
		}
	}
}

async function fetchLeaderboard() {
	const leaderboardData = await got(`https://adventofcode.com/${process.env.AOC_LEADERBOARD_YEAR}/leaderboard/private/view/${process.env.AOC_LEADERBOARD_ID}.json`, {
		headers: {
			Cookie: `session=${process.env.AOC_SESSION}`,
			'User-Agent': process.env.USER_AGENT,
		},
		json: true,
	});
	const newLeaderboard = new Map(Object.values(leaderboardData.body.members).map(e => [e.id, e.stars]));
	return newLeaderboard;
}

async function resetNickname(guild, aocId) {
	const claim = await Claim.findOne({guildId: guild.id, aocId}).exec();
	if (!claim) {
		return;
	}
	const discordId = claim.discordId;
	const member = guild.member(discordId);
	if (!member || guild.ownerID === member.id) {
		return;
	}

	let baseName;
	const match = /^(.+)⭐\s*[0-9]+|\?$/.exec(member.displayName);
	if (match) {
		baseName = match[1].trim();
	} else {
		baseName = member.displayName;
	}
	await member.setNickname(baseName === member.user.username ? null : baseName);
}

async function updateNickname(guild, aocId) {
	const claim = await Claim.findOne({guildId: guild.id, aocId}).exec();
	if (!claim) {
		return;
	}
	const discordId = claim.discordId;
	const member = guild.member(discordId);
	if (!member || guild.ownerID === member.id) {
		return;
	}

	let baseName;
	const match = /^(.+)⭐\s*(?:[0-9]+|\?)$/.exec(member.displayName);
	if (match) {
		baseName = match[1].trim();
	} else {
		baseName = member.displayName;
	}
	const newNickname = `${baseName} ⭐${leaderboard.get(aocId) || '?'}`;
	if (member.nickname !== newNickname) {
		await member.setNickname(newNickname);
	}
}
