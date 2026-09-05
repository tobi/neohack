import type { Identity } from "neonethack/types";

export const roles: {
  id: string;
  title: string;
  description: string;
  art: string;
  frameWidth?: number;
  identity: Identity;
}[] = [
  {
    id: "valkyrie",
    title: "The Valkyrie",
    description:
      "A sturdy first step. A shield, a sword, and a little courage.",
    art: "valkyrie-original",
    frameWidth: 24,
    identity: {
      role: "valkyrie",
      race: "human",
      gender: "female",
      align: "lawful",
    },
  },
  {
    id: "wizard",
    title: "The Wizard",
    description: "For the curious. Books, magic, and wonderfully risky ideas.",
    art: "wizard-original",
    frameWidth: 24,
    identity: {
      role: "wizard",
      race: "human",
      gender: "male",
      align: "neutral",
    },
  },
  {
    id: "ranger",
    title: "The Ranger",
    description: "Travel light. A bow, keen eyes, and a path of your own.",
    art: "ranger-original",
    frameWidth: 24,
    identity: {
      role: "ranger",
      race: "elf",
      gender: "female",
      align: "chaotic",
    },
  },
{
  "id": "archeologist",
  "title": "The Archeologist",
  "description": "A field scholar with a pick-axe, a whip and a nose for discovery.",
  "art": "archeologist",
  "identity": {
    "role": "archeologist",
    "race": "human",
    "gender": "male",
    "align": "lawful"
  }
},
{
  "id": "barbarian",
  "title": "The Barbarian",
  "description": "Heavy weapons and raw strength. Meet danger head-on.",
  "art": "barbarian",
  "identity": {
    "role": "barbarian",
    "race": "human",
    "gender": "female",
    "align": "neutral"
  }
},
{
  "id": "caveman",
  "title": "The Caveman",
  "description": "A club, a sling and the instincts of a survivor.",
  "art": "caveman",
  "identity": {
    "role": "caveman",
    "race": "human",
    "gender": "male",
    "align": "lawful"
  }
},
{
  "id": "healer",
  "title": "The Healer",
  "description": "Medicine, healing magic and a careful approach to danger.",
  "art": "healer",
  "identity": {
    "role": "healer",
    "race": "human",
    "gender": "female",
    "align": "neutral"
  }
},
{
  "id": "knight",
  "title": "The Knight",
  "description": "Armor, a lance and a pony. Adventure with a code of honor.",
  "art": "knight",
  "identity": {
    "role": "knight",
    "race": "human",
    "gender": "male",
    "align": "lawful"
  }
},
{
  "id": "monk",
  "title": "The Monk",
  "description": "Martial arts and discipline. Let your hands do the fighting.",
  "art": "monk",
  "identity": {
    "role": "monk",
    "race": "human",
    "gender": "male",
    "align": "neutral"
  }
},
{
  "id": "priest",
  "title": "The Priest",
  "description": "A mace, sacred rites and knowledge of blessings and curses.",
  "art": "priest",
  "identity": {
    "role": "priest",
    "race": "human",
    "gender": "male",
    "align": "lawful"
  }
},
{
  "id": "rogue",
  "title": "The Rogue",
  "description": "Daggers, stealth and an eye for opportunities.",
  "art": "rogue",
  "identity": {
    "role": "rogue",
    "race": "human",
    "gender": "female",
    "align": "chaotic"
  }
},
{
  "id": "samurai",
  "title": "The Samurai",
  "description": "A katana and a bow. Balance close combat with ranged skill.",
  "art": "samurai",
  "identity": {
    "role": "samurai",
    "race": "human",
    "gender": "female",
    "align": "lawful"
  }
},
{
  "id": "tourist",
  "title": "The Tourist",
  "description": "A camera, darts and packed lunches. A challenging holiday.",
  "art": "tourist",
  "identity": {
    "role": "tourist",
    "race": "human",
    "gender": "male",
    "align": "neutral"
  }
},
];

export function heroArt(role?: string): string {
  return roles.find((entry) => entry.id === role)?.art ?? "valkyrie-original";
}

/** Art geometry only; the engine ground grid remains 16x16. */
export function heroFrameWidth(art: string): number {
  return roles.find((entry) => entry.art === art)?.frameWidth ?? 16;
}
