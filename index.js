require('dotenv').config();

const cron = require('cron');
const Discord = require('discord.js');
const got = require('got');
const mongoose = require('mongoose');

const Claim = require('./Claim.js');

const client = new Discord.Client({
	intents: ['GUILDS', 'GUILD_MESSAGES'],
});

let leaderboard = new Map();

client.once('ready', async () => {
	await client.application.commands.set([
		{
			name: 'claim',
			description: 'Link your Discord account to your Advent of Code account.',
			type: 'CHAT_INPUT',
			options: [
				{
					type: 'STRING',
					name: 'aoc_user_id',
					description: 'Your AoC user ID. You can find this number on your AoC settings page.',
					required: true,
				},
			],
		},
		{
			name: 'unclaim',
			description: 'Unlink your Discord account from your Advent of Code account.',
			type: 'CHAT_INPUT',
		},
		{
			name: 'verify',
			description: 'Verify that a user\'s displayed star count is accurate.',
			type: 'CHAT_INPUT',
			options: [
				{
					type: 'USER',
					name: 'user',
					description: 'The user whose star count to verify.',
					required: true,
				},
			],
		},
		{
			name: 'leaderboard',
			description: 'Show leaderboard.',
			type: 'CHAT_INPUT',
		},
	]);

	await update();

	// regularly get leaderboard data
	cron.job('0 */10 5 1-25 12 *', update, null, true, 'UTC'); // every 10 minutes for the first hour after unlock
	cron.job('0 */15 1-4,6-23 1-25 12 *', update, null, true, 'UTC'); // every 15 minutes for the rest of the day
	cron.job('0 */15 * 26-31 12 *', update, null, true, 'UTC'); // after the last unlock, only every 15 minutes
});

client.on('interactionCreate', async (interaction) => {
	try {
		if (!interaction.isCommand()) {
			return;
		}
		switch (interaction.commandName) {
			case 'claim': {
				const aocId = interaction.options.getString('aoc_user_id');
				if (!/^[0-9]+$/.test(aocId)) {
					return interaction.reply('Invalid ID.');
				}
				const exisiting = await Claim.findOne({guildId: interaction.guild.id, $or: [{discordId: interaction.user.id}, {aocId: aocId}]}).exec();
				if (exisiting) {
					if (exisiting.aocId === aocId) {
						return interaction.reply('This AoC account has already been claimed.');
					}
					if (exisiting.discordId === interaction.user.id) {
						return interaction.reply('You have already claimed an AoC account.');
					}
				}
				const claim = new Claim({guildId: interaction.guild.id, discordId: interaction.user.id, aocId});
				await claim.save();
				await updateNickname(interaction.guild, aocId);
				await interaction.reply('AoC account successfully claimed.');
				break;
			}

			case 'unclaim': {
				const claim = await Claim.findOne({guildId: interaction.guild.id, discordId: interaction.user.id}).exec();
				if (!claim) {
					return interaction.reply('You haven\'t claimed an AoC account yet.');
				}
				const aocId = claim.aocId;
				await resetNickname(interaction.guild, aocId);
				await claim.delete();
				await interaction.reply('AoC account successfully unclaimed.');
				break;
			}

			case 'verify': {
				const user = interaction.options.getUser('user');
				const claim = await Claim.findOne({guildId: interaction.guild.id, discordId: user.id}).exec();
				let member;
				try {
					member = await interaction.guild.members.fetch(user.id);
				} catch (err) {
					// no-op
				}
				if (!claim || !member) {
					return interaction.reply('❌');
				}
				const starMatch = /^.+⭐\s*(\d+|\?)$/.exec(member.displayName);
				if (!starMatch) {
					return interaction.reply('❌');
				}
				const nicknameStars = Number(starMatch[1]) || '?';
				if (nicknameStars === (leaderboard.get(claim.aocId) || '?')) {
					return interaction.reply('✅');
				} else {
					return interaction.reply('❌');
				}
			}

			case 'leaderboard': {
				const claims = await Claim.find({guildId: interaction.guild.id}).exec();
				const guildLeaderboardData = [];

				if (claims.length === 0) {
					await interaction.reply('No users in this server have claimed an AoC account.');
					break;
				}

				for (const claim of claims) {
					let member;
					try {
						member = await interaction.guild.members.fetch(claim.discordId);
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

				const [replyContent, ...followUpContents] = Discord.Util.splitMessage('```\n' + generateGuildLeaderboard(guildLeaderboardData) + '\n```', {
					prepend: '```\n',
					append: '\n```',
				});

				await interaction.reply(replyContent);
				for (const followUpContent of followUpContents) {
					try {
						await interaction.channel.send(followUpContent);
					} catch (err) {
						await interaction.followUp(followUpContent);
					}
				}
			}
		}
	} catch (err) {
		console.error(err);
	}
});

client.on('messageCreate', async (message) => {
	if (message.author.id === process.env.WEBHOOK_ID) {
		const date = new Date();
		message.startThread({name: `Advent of Code ${date.getUTCFullYear()}: Day ${date.getUTCDate()}`});
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
	for (const guild of [...client.guilds.cache.values()]) {
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
	const newLeaderboard = new Map(Object.values(leaderboardData.body.members).map(e => [String(e.id), e.stars]));
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
	if (!member || guild.ownerId === member.id) {
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
