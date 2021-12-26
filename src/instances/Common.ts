import {
    Collection,
    EmojiIdentifierResolvable, GuildMember,
    MessageButton,
    MessageComponentInteraction,
    MessageSelectMenu,
    TextChannel
} from "discord.js";
import {
    IAfkCheckReaction,
    IDungeonInfo,
    IDungeonModifier,
    IGuildInfo,
    IMappedAfkCheckReactions,
    IReactionInfo, ISectionInfo, ReactionType
} from "../definitions";
import {GuildFgrUtilities} from "../utilities/fetch-get-request/GuildFgrUtilities";
import {StringUtil} from "../utilities/StringUtilities";
import {AdvancedCollector} from "../utilities/collectors/AdvancedCollector";
import {HIGHEST_MODIFIER_LEVEL} from "../constants/DungeonModifiers";
import {StringBuilder} from "../utilities/StringBuilder";
import {MAPPED_AFK_CHECK_REACTIONS} from "../constants/MappedAfkCheckReactions";
import {GlobalFgrUtilities} from "../utilities/fetch-get-request/GlobalFgrUtilities";

export type ReactionInfoMore = IReactionInfo & {
    earlyLocAmt: number;
    isCustomReaction: boolean;
    builtInEmoji?: EmojiIdentifierResolvable;
};

export interface IKeyReactInfo {
    mapKey: keyof IMappedAfkCheckReactions;
    modifiers: string[];
    accidentCt: number;
}

/**
 * Confirms the key reacts. This asks the person what modifiers the key has.
 * @param {MessageComponentInteraction} interaction The interactions.
 * @param {Collection<string, ReactionInfoMore>} essentialOptions The essential reactions. Note that
 * `interaction.customId` must be a key in `essentialOptions`.
 * @param {readonly IDungeonModifier[]} modifiers The dungeon modifiers that are allowed.
 * @param {boolean} [isAfk] Whether this is an AFK check. If this is not an AFK check, then only the key checker
 * will be invoked.
 * @returns {Promise<IKeyReactInfo | null>} The reaction result, if any.
 */
export async function confirmReaction(
    interaction: MessageComponentInteraction,
    essentialOptions: Collection<string, ReactionInfoMore>,
    modifiers: readonly IDungeonModifier[],
    isAfk: boolean = true
): Promise<IKeyReactInfo | null> {
    if (!interaction.guild)
        return null;

    const member = await GuildFgrUtilities.fetchGuildMember(interaction.guild, interaction.user.id);
    if (!member)
        return null;

    const mapKey = interaction.customId;
    const reactInfo = essentialOptions.get(mapKey)!;
    const itemDisplay = getItemDisplay(reactInfo);
    const uniqueIdentifier = StringUtil.generateRandomString(20);

    if (reactInfo.type === "KEY") {
        const selectMenu = new MessageSelectMenu()
            .setMinValues(0)
            .setMaxValues(4)
            .setCustomId(`${uniqueIdentifier}_select`);
        for (const modifier of modifiers) {
            selectMenu.addOptions({
                description: modifier.description,
                label: modifier.modifierName,
                value: modifier.modifierName
            });
        }

        const noModifierId = `${uniqueIdentifier}_no_modifier`;
        const noneListedId = `${uniqueIdentifier}_none_listed`;
        const cancelModId = `${uniqueIdentifier}_cancel_mods`;
        const cancelButton = new MessageButton()
            .setLabel("Cancel")
            .setStyle("DANGER")
            .setCustomId(cancelModId);

        await interaction.reply({
            ephemeral: true,
            content: `You pressed the ${itemDisplay} button. What modifiers does this key have? *Select all that`
                + " apply*. Please note that *not all modifiers* will be listed; if you have at least one"
                + " modifier that is listed in the select menu below, select it. If none of the modifiers that"
                + " you have are listed in the select menu, then press the **None Listed** button. You have two"
                + " minutes to answer this question. **Lying about what modifiers your key has may result in"
                + " consequences**; thus, it is important that you be careful when selecting what modifiers your"
                + " key has.\n"
                + "- If you have **multiple** keys, please specify the modifiers for **one** of your keys and"
                + " message the raid leader the modifiers of the remaining key.\n"
                + "- If you do not have any modifiers, please press the **No Modifier** button.\n"
                + "- If you did not mean to press this button, please press the **Cancel** button.",
            components: AdvancedCollector.getActionRowsFromComponents([
                selectMenu,
                new MessageButton()
                    .setLabel("No Modifier")
                    .setStyle("PRIMARY")
                    .setCustomId(noModifierId),
                new MessageButton()
                    .setLabel("None Listed")
                    .setStyle("PRIMARY")
                    .setCustomId(noneListedId),
                cancelButton
            ])
        });

        const modifierRes = await AdvancedCollector.startInteractionEphemeralCollector({
            targetChannel: interaction.channel!,
            duration: 2 * 60 * 1000,
            targetAuthor: interaction.user,
            acknowledgeImmediately: true
        }, uniqueIdentifier);

        if (!modifierRes) {
            await interaction.editReply({
                content: "You did not respond to this question in time.",
                components: []
            });

            return null;
        }

        if (modifierRes.isButton()) {
            switch (modifierRes.customId) {
                case noModifierId: {
                    return {mapKey, modifiers: [], accidentCt: 0};
                }
                case noneListedId: {
                    return {mapKey, modifiers: ["N/A"], accidentCt: 0};
                }
                default: {
                    return null;
                }
            }
        }

        // Should never hit
        if (!modifierRes.isSelectMenu())
            return null;

        const selectedModifiers = modifiers
            .filter(x => modifierRes.values.includes(x.modifierName));

        const returnObj: IKeyReactInfo = {mapKey: mapKey, modifiers: [], accidentCt: 0};
        // Define all possible buttons, don't construct new buttons for each modifier
        const numButtons: MessageButton[] = [];
        const accidentCustomId = `${uniqueIdentifier}_accident`;
        const accidentButton = new MessageButton()
            .setLabel("Accident")
            .setCustomId(accidentCustomId)
            .setStyle("DANGER");

        for (let i = 0; i < HIGHEST_MODIFIER_LEVEL; i++) {
            numButtons.push(
                new MessageButton()
                    .setLabel((i + 1).toString())
                    .setCustomId(`${uniqueIdentifier}_${(i + 1)}`)
                    .setStyle("PRIMARY")
            );
        }

        // ask for individual levels.
        for (const modifier of selectedModifiers) {
            if (modifier.maxLevel === 1) {
                returnObj.modifiers.push(modifier.modifierName);
                continue;
            }

            const buttonsToUse: MessageButton[] = [cancelButton, accidentButton];
            for (let i = 0; i < modifier.maxLevel; i++) {
                buttonsToUse.push(numButtons[i]);
            }

            await interaction.editReply({
                content: `What **level** is the **${modifier.modifierName}** modifier? If you want to cancel this,`
                    + " press the **Cancel** button. If you mistakenly selected this modifier, press the"
                    + " **Accident** button.",
                components: AdvancedCollector.getActionRowsFromComponents(buttonsToUse)
            });

            const levelRes = await AdvancedCollector.startInteractionEphemeralCollector({
                targetChannel: interaction.channel!,
                duration: 2 * 60 * 1000,
                targetAuthor: interaction.user,
                acknowledgeImmediately: true
            }, uniqueIdentifier);

            if (!levelRes) {
                return null;
            }

            if (levelRes.customId === accidentCustomId) {
                returnObj.accidentCt++;
                continue;
            }

            if (levelRes.customId === cancelModId)
                return null;

            returnObj.modifiers.push(`${modifier.modifierName} ${levelRes.customId.split("_")[1]}`);
        }

        return returnObj;
    }
    else if (!isAfk)
        return null;

    if (reactInfo.type === "EARLY_LOCATION") {
        return {mapKey: mapKey, modifiers: [], accidentCt: 0};
    }

    // Ask the member if they're willing to actually bring said priority item
    const contentDisplay = new StringBuilder()
        .append(`You pressed the ${itemDisplay} button.`)
        .appendLine(2)
        .append(`Please confirm that you will bring ${itemDisplay} to the raid by pressing `)
        .append("the **Yes** button. If you **do not** plan on bring said selection, then please press **No** ")
        .append("or don't respond.")
        .appendLine(2)
        .append("You have **15** seconds to select an option. Failure to respond will result in an ")
        .append("automatic **no**.")
        .toString();

    const [, response] = await AdvancedCollector.askBoolFollowUp({
        interaction: interaction,
        time: 15 * 1000,
        contentToSend: {
            content: contentDisplay.toString()
        },
        channel: interaction.channel as TextChannel
    });

    // Response of "no" or failure to respond implies no.
    if (!response)
        return null;

    return {mapKey: mapKey, modifiers: [], accidentCt: 0};
}


/**
 * Gets all relevant reactions for this dungeon. This accounts for overrides as well.
 * @param {IDungeonInfo} dungeon The dungeon.
 * @param {IGuildInfo} guildDoc The guild document.
 * @param {ReactionType[]} [filterBy] What specific reactions to get. This should be used if you only want a
 * particular set of reactions (e.g. only key reactions). If this isn't specified, then all reactions will be
 * considered.
 * @return {Collection<string, ReactionInfoMore>} The collection of reactions. The key is the mapping key and
 * the value is the reaction information (along with the number of early locations).
 */
export function getReactions(dungeon: IDungeonInfo, guildDoc: IGuildInfo,
                             filterBy?: ReactionType[]): Collection<string, ReactionInfoMore> {
    const reactions = new Collection<string, ReactionInfoMore>();

    // Define a local function that will check both MappedAfkCheckReactions & customReactions for reactions.
    function findAndAddReaction(reaction: IAfkCheckReaction): void {
        // Is the reaction key in MappedAfkCheckReactions? If so, it's as simple as grabbing that data.
        if (reaction.mapKey in MAPPED_AFK_CHECK_REACTIONS) {
            const obj = MAPPED_AFK_CHECK_REACTIONS[reaction.mapKey];
            if (obj.emojiInfo.isCustom && !GlobalFgrUtilities.hasCachedEmoji(obj.emojiInfo.identifier)) {
                return;
            }

            if (!filterBy?.includes(obj.type)) {
                return;
            }

            reactions.set(reaction.mapKey, {
                ...obj,
                earlyLocAmt: reaction.maxEarlyLocation,
                isCustomReaction: false
            });
            return;
        }

        // Is the reaction key associated with a custom emoji? If so, grab that as well.
        const customEmoji = guildDoc.properties.customReactions.find(x => x.key === reaction.mapKey);
        if (customEmoji) {
            if (customEmoji.value.emojiInfo.isCustom
                && !GlobalFgrUtilities.hasCachedEmoji(customEmoji.value.emojiInfo.identifier)) {
                return;
            }

            if (!filterBy?.includes(customEmoji.value.type)) {
                return;
            }

            reactions.set(reaction.mapKey, {
                ...customEmoji.value,
                earlyLocAmt: reaction.maxEarlyLocation,
                isCustomReaction: true
            });
        }
    }

    // If the dungeon is base or derived base, we need to check for dungeon overrides.
    if (dungeon.isBuiltIn) {
        // Check if we need to deal with any dungeon overrides.
        const overrideIdx = guildDoc.properties.dungeonOverride.findIndex(x => x.codeName === dungeon.codeName);

        if (overrideIdx !== -1) {
            // We need to deal with overrides. In this case, go through every reaction defined in the override
            // info and add them to the collection of reactions.
            const overrideInfo = guildDoc.properties.dungeonOverride[overrideIdx];

            for (const reaction of overrideInfo.keyReactions.concat(overrideInfo.otherReactions)) {
                findAndAddReaction(reaction);
            }

            // We don't need to check anything else.
            return reactions;
        }

        // Otherwise, we 100% know that this is the base dungeon with no random custom emojis.
        // Get all keys + reactions
        for (const key of dungeon.keyReactions.concat(dungeon.otherReactions)) {
            if (!filterBy?.includes(MAPPED_AFK_CHECK_REACTIONS[key.mapKey].type)) {
                continue;
            }

            reactions.set(key.mapKey, {
                ...MAPPED_AFK_CHECK_REACTIONS[key.mapKey],
                earlyLocAmt: key.maxEarlyLocation,
                isCustomReaction: false
            });
        }

        return reactions;
    }

    // Otherwise, this is a fully custom dungeon, so we can simply just combine all reactions into one array and
    // process that.
    for (const r of dungeon.keyReactions.concat(dungeon.otherReactions)) {
        findAndAddReaction(r);
    }

    return reactions;
}



/**
 * Checks whether a person can manage raids in the specified section. The section must have a control panel and
 * AFK check channel defined, the person must have at least one leader role, and the channels must be under a
 * category.
 * @param {ISectionInfo} section The section in question.
 * @param {GuildMember} member The member in question.
 * @param {IGuildInfo} guildInfo The guild document.
 * @return {boolean} Whether the person can manage raids in the specified section.
 * @static
 */
export function canManageRaidsIn(section: ISectionInfo, member: GuildMember, guildInfo: IGuildInfo): boolean {
    const guild = member.guild;

    // Verified role doesn't exist.
    if (!GuildFgrUtilities.hasCachedRole(guild, section.roles.verifiedRoleId))
        return false;

    // Control panel does not exist.
    if (!GuildFgrUtilities.hasCachedChannel(guild, section.channels.raids.controlPanelChannelId))
        return false;

    // AFK check does not exist.
    if (!GuildFgrUtilities.hasCachedChannel(guild, section.channels.raids.afkCheckChannelId))
        return false;

    const cpCategory = GuildFgrUtilities.getCachedChannel<TextChannel>(
        guild,
        section.channels.raids.controlPanelChannelId
    )!;

    const acCategory = GuildFgrUtilities.getCachedChannel<TextChannel>(
        guild,
        section.channels.raids.afkCheckChannelId
    )!;

    // AFK check and/or control panel do not have categories.
    if (!cpCategory.parent || !acCategory.parent)
        return false;

    // Categories are not the same.
    if (cpCategory.parent.id !== acCategory.parent.id)
        return false;

    return [
        section.roles.leaders.sectionVetLeaderRoleId,
        section.roles.leaders.sectionLeaderRoleId,
        section.roles.leaders.sectionAlmostLeaderRoleId,
        guildInfo.roles.staffRoles.universalLeaderRoleIds.almostLeaderRoleId,
        guildInfo.roles.staffRoles.universalLeaderRoleIds.leaderRoleId,
        guildInfo.roles.staffRoles.universalLeaderRoleIds.vetLeaderRoleId,
        guildInfo.roles.staffRoles.universalLeaderRoleIds.headLeaderRoleId
    ].some(x => GuildFgrUtilities.memberHasCachedRole(member, x));
}



/**
 * Gets the item display.
 * @param {ReactionInfoMore} reactInfo More reaction information.
 * @returns {string} The item display.
 */
export function getItemDisplay(reactInfo: ReactionInfoMore): string {
    return `${GlobalFgrUtilities.getNormalOrCustomEmoji(reactInfo) ?? ""} **\`${reactInfo.name}\`**`.trim();
}