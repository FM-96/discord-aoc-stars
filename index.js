require('dotenv').config();

const cron = require('cron');
const Discord = require('discord.js');
const got = require('got');
const mongoose = require('mongoose');

const Claim = require('./Claim.js');

const client = new Discord.Client({
	ws: {
		intents: Discord.Intents.NON_PRIVILEGED,
	},
});

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
				let member;
				try {
					member = await message.guild.members.fetch(discordId);
				} catch (err) {
					// no-op
				}
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

			case message.content.startsWith('aoc leaderboard'): {
				const claims = await Claim.find({guildId: message.guild.id}).exec();
				const guildLeaderboardData = [];

				for (const claim of claims) {
					let member;
					try {
						member = await message.guild.members.fetch(claim.discordId);
					} catch (err) {
						// no-op
					}
					if (!member) {
						continue;
					}
					guildLeaderboardData.push({
						name: getBaseName(member),
						stars: leaderboard.has(claim.aocId) ? leaderboard.get(claim.aocId) : '?',
					});
				}

				await message.channel.send('```\n' + generateGuildLeaderboard(guildLeaderboardData) + '\n```', {
					split: {
						prepend: '```\n',
						append: '\n```',
					},
				});
			}
		}
	} catch (err) {
		console.error(err);
	}
});

mongoose.connect(process.env.DATABASE, {useNewUrlParser: true, useUnifiedTopology: true}).then(() => client.login(process.env.BOT_TOKEN)).catch(err => {
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
	for (const guild of client.guilds.cache.array()) {
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

function getBaseName(member) {
	const match = /^(.+)⭐\s*(?:[0-9]+|\?)$/.exec(member.displayName);
	if (match) {
		return match[1].trim();
	} else {
		return member.displayName;
	}
}

async function getDiscordMember(guild, aocId) {
	const claim = await Claim.findOne({guildId: guild.id, aocId}).exec();
	if (!claim) {
		return null;
	}
	const discordId = claim.discordId;
	let member;
	try {
		member = await guild.members.fetch(discordId);
	} catch (err) {
		// no-op
	}
	if (!member || guild.ownerID === member.id) {
		return null;
	}
	return member;
}

async function resetNickname(guild, aocId) {
	const member = await getDiscordMember(guild, aocId);
	if (!member) {
		return;
	}

	const baseName = getBaseName(member);
	await member.setNickname(baseName);
}

async function updateNickname(guild, aocId) {
	const member = await getDiscordMember(guild, aocId);
	if (!member) {
		return;
	}

	const baseName = getBaseName(member);
	const newNickname = `${baseName} ⭐${leaderboard.has(aocId) ? leaderboard.get(aocId) : '?'}`;
	if (member.nickname !== newNickname) {
		await member.setNickname(newNickname);
	}
}

function generateGuildLeaderboard(data) {
	let guildLeaderboard = '';

	const sortedData = data.filter(e => e.stars !== '?');
	sortedData.sort((a, b) => b.stars - a.stars);
	sortedData.push(...data.filter(e => e.stars === '?'));

	let position = 0;
	for (let i = 0; i < sortedData.length; ++i) {
		const entry = sortedData[i];
		const prevEntry = sortedData[i - 1];
		if (!prevEntry || entry.stars !== prevEntry.stars) {
			position = i + 1;
		}

		guildLeaderboard += `${(entry.stars === '?' ? '?' : String(position)).padStart(String(sortedData.length).length)}. ${String(entry.stars).padStart(2)}⭐ ${entry.name}\n`;
	}

	return guildLeaderboard;
}
