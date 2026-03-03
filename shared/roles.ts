export enum Role {
    VILLAGER = "VILLAGER",
    WEREWOLF = "WEREWOLF",
    SEER = "SEER",
    CUPID = "CUPID",
    WITCH = "WITCH",
    RED_LADY = "RED_LADY",
    LITTLE_GIRL = "LITTLE_GIRL",
    // HUNTER = "HUNTER"
}

export enum Team {
    VILLAGE = "VILLAGE",
    WOLF = "WOLF"
}

export interface RoleDef {
    role: Role;
    displayName: string;
    pluralName: string;
    description: string;
    narratorNotes: string;
    wakesUp: boolean;
    nightOrder: number; // Lower wakes first. -1 or 999 for never.
    onlyFirstNight?: boolean;
    maxAmount?: number;
    team: Team;
}

export const ROLES: Record<Role, RoleDef> = {
    [Role.CUPID]: {
        role: Role.CUPID,
        displayName: "Cupid",
        pluralName: "Cupids",
        description: "On the first night, you can choose two players to fall in love. If one lover dies, the other dies as well.",
        narratorNotes: "On the first night, wake Cupid, have them point two lovers, wake those players briefly to tell them, mark lovers, close eyes.",
        wakesUp: true,
        nightOrder: 1,
        onlyFirstNight: true,
        maxAmount: 1,
        team: Team.VILLAGE
    },
    [Role.RED_LADY]: {
        role: Role.RED_LADY,
        displayName: "Red Lady",
        pluralName: "Red Ladies",
        description: "Each night, choose one player to visit. If you are attacked while visiting, you survive. But if your host is attacked that night, you die too.",
        narratorNotes: "Wake Red Lady, have them point a player to visit, note choice, close eyes.",
        wakesUp: true,
        nightOrder: 2,
        maxAmount: 1,
        team: Team.VILLAGE
    },
    [Role.WEREWOLF]: {
        role: Role.WEREWOLF,
        displayName: "Werewolf",
        pluralName: "Werewolves",
        description: "Each night, you wake up to collectively choose one player to eliminate from the game.",
        narratorNotes: "Wake werewolves, let them silently point a victim, note choice, close eyes.",
        wakesUp: true,
        nightOrder: 3,
        team: Team.WOLF
    },
    [Role.SEER]: {
        role: Role.SEER,
        displayName: "Seer",
        pluralName: "Seers",
        description: "Each night, you can look at the card of one other player to learn their true identity.",
        narratorNotes: "Wake Seer, have them point a player, tell whether the player is a werewolf or not, close eyes.",
        wakesUp: true,
        nightOrder: 4,
        maxAmount: 1,
        team: Team.VILLAGE
    },
    [Role.WITCH]: {
        role: Role.WITCH,
        displayName: "Witch",
        pluralName: "Witches",
        description: "You have two potions: One Healing, one Kill. You will be shown the victim of the Werewolves and can decide: Heal them, kill someone else, or do nothing?",
        narratorNotes: "Wake Witch, show wolf victim, ask: use heal? then ask: use kill? Mark potions used, close eyes.",
        wakesUp: true,
        nightOrder: 5,
        maxAmount: 1,
        team: Team.VILLAGE
    },
    [Role.VILLAGER]: {
        role: Role.VILLAGER,
        displayName: "Villager",
        pluralName: "Villagers",
        description: "You have no special ability. Nonetheless you can help to lynch the Werewolves during the day.",
        narratorNotes: "No night action. During day, prompt discussion and run the lynch vote.",
        wakesUp: false,
        nightOrder: -1,
        team: Team.VILLAGE
    },
    // [Role.HUNTER]: {
    //     role: Role.HUNTER,
    //     displayName: "Hunter",
    //     pluralName: "Hunters",
    //     description: "If you are eliminated, you have the power to fire a final shot and take one other player down with you.",
    //     narratorNotes: "When eliminated: Ask Hunter to point one final target; resolve that elimination immediately.",
    //     wakesUp: false,
    //     nightOrder: -1,
    //     team: Team.VILLAGE
    // },
    [Role.LITTLE_GIRL]: {
        role: Role.LITTLE_GIRL,
        displayName: "Little Girl",
        pluralName: "Little Girls",
        description: "You have the power to peek while the Werewolves are choosing their victim.",
        narratorNotes: "During werewolf phase: Allow a brief, secret peek, then close eyes.",
        wakesUp: false,
        nightOrder: -1,
        maxAmount: 1,
        team: Team.VILLAGE
    }
};
