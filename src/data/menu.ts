export interface MenuItemVariation {
  id: string;
  name: string;
  price: number; // in cents
}

export interface ModifierOption {
  id: string;
  name: string;
  price: number; // in cents
}

export interface ModifierList {
  id: string;
  name: string;
  modifiers: ModifierOption[];
}

export interface MenuItem {
  id: string;
  name: string;
  description: string | null;
  category: string;
  variations: MenuItemVariation[];
  modifierListIds: string[];
  imageId: string | null;
  price: number; // display price in cents (first variation)
}

export const MODIFIER_LISTS: ModifierList[] = [
  {
    id: "R36X2UV64QOYY4K2H7OHLA4K",
    name: "Choose Two Sides",
    modifiers: [
      { id: "6JFBBZ5ZZLYVIUCUMWE4ZSGF", name: "Cream Spinach", price: 0 },
      { id: "7XHMUDUMPK3EOHHOFIWARASP", name: "Fries", price: 0 },
      { id: "VPSUPUGFRR3JZXYA6RNIVVBG", name: "Kale", price: 0 },
      { id: "KVIRM5SLFEUWWUSC76QDVSZL", name: "Mac and Cheese", price: 0 },
      { id: "SHPWYF7P35QPPFGOSZNAQP7G", name: "Mash Potatoes", price: 0 },
      { id: "SFRBPOSXJPGYJTXDF3FQ6PWV", name: "Rice", price: 0 },
      { id: "AJEY3W2G4VU7HLK746B6Z2XS", name: "Roasted Asparagus", price: 0 },
      { id: "J5FOY2ZDNKEKKAIZEKRKFBZ4", name: "Roasted Broccolini", price: 0 },
      { id: "3RBO73NVWFQX5IE6XHR7H4AL", name: "Roasted Brussels", price: 0 },
      { id: "BLFND4DDW2KLRC2TG7DBCKHQ", name: "Side Salad", price: 0 },
      { id: "SJEYVDZNSJ6KJMFGHKTGQRQ7", name: "Sweet & Spicy Brussels", price: 500 },
      { id: "ILQX4KOHGALJWRY5HKMGZEKV", name: "Sweet Potato Casserole", price: 0 },
      { id: "H7CQX6Y6P66LGLNFP6DMNKVY", name: "Veggie Medley", price: 0 },
      { id: "ZGDWO4LRUGP6KKYGMP6S4UTY", name: "Yams", price: 0 },
    ],
  },
  {
    id: "EAOE3UPUWX5JQE67P4RVBI3L",
    name: "Choose Protein",
    modifiers: [
      { id: "RS63FHCBTFKLYWPVB3Q776VG", name: "Chicken Breast", price: 1200 },
      { id: "N6GC5I77WPVA3GSRFSSXXEPA", name: "Shrimp", price: 1300 },
      { id: "CGADYWJB6XKFRPTSV4E27WSM", name: "Fried Shrimp", price: 1400 },
      { id: "263VHPGP3L6I35BCFXREUWJU", name: "Fried Catfish", price: 1500 },
      { id: "34ARGCMJ4Z2ACQI2K55Q2WJH", name: "Grilled Lobster", price: 2000 },
      { id: "IHG3647V63ZHZA2CYEN5PCIM", name: "Fried Lobster", price: 2500 },
      { id: "YUHE557F4FFFK6URTVZQWZQS", name: "Salmon Filet", price: 2500 },
      { id: "IAFRIFRNUBFJI67F4G5JNF4U", name: "BBQ Jerk Lamb", price: 3000 },
      { id: "AXVBPRA4WOU7WTRW2IIMH7UV", name: "Honey Jerk Lamb", price: 3000 },
      { id: "P6ZQNL3KFFUIY6MQ2Y4UIJ7S", name: "Crab Cake", price: 3000 },
      { id: "ZTKW6TD7AUVJHER63F46KBFV", name: "Stuffed Salmon", price: 4500 },
      { id: "P74KNNHY3HTT3SWDUDFZNS6H", name: "Stuffed Lobster", price: 4500 },
    ],
  },
];

export type CategorySlug =
  | "small-plates"
  | "salads"
  | "entrees-land"
  | "entrees-sea"
  | "pasta"
  | "sandwiches"
  | "sides"
  | "desserts"
  | "drinks";

export interface Category {
  slug: CategorySlug;
  name: string;
}

export const CATEGORIES: Category[] = [
  { slug: "small-plates", name: "Small Plates & Apps" },
  { slug: "salads", name: "Salads" },
  { slug: "entrees-land", name: "Entrees — Land" },
  { slug: "entrees-sea", name: "Entrees — Sea" },
  { slug: "pasta", name: "Pasta" },
  { slug: "sandwiches", name: "Sandwiches" },
  { slug: "sides", name: "Sides" },
  { slug: "desserts", name: "Desserts" },
  { slug: "drinks", name: "Drinks" },
];

function titleCase(str: string): string {
  return str
    .toLowerCase()
    .split(" ")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

export const MENU_ITEMS: MenuItem[] = [
  // ── Small Plates & Apps ──
  {
    id: "DFN63PAAP5USEYHSQHD5LRT3",
    name: "Crab Cake Egg Rolls",
    description: "Crispy egg rolls stuffed with premium lump crab meat, served with a tangy dipping sauce.",
    category: "small-plates",
    variations: [{ id: "J3BPSTZGABYWVLSJIPYH2Y4I", name: "Regular", price: 1200 }],
    modifierListIds: [],
    imageId: "WV7LCGHYEUASCCWL2AOPKCXU",
    price: 1200,
  },
  {
    id: "V6TOWYINJHJMBILSHV4RML6M",
    name: "Cheesesteak Egg Rolls",
    description: "Crispy egg rolls filled with seasoned cheesesteak and melted cheese.",
    category: "small-plates",
    variations: [{ id: "XLCTS5MC22P2K22IYL54VGYJ", name: "Regular", price: 1500 }],
    modifierListIds: [],
    imageId: null,
    price: 1500,
  },
  {
    id: "PKLRMJJ53HALFC2A5PJ3JVRP",
    name: "Wings",
    description: "Crispy jumbo wings tossed in your choice of signature sauce.",
    category: "small-plates",
    variations: [{ id: "UUWGHYSMS6C5BULKDU4K5KRY", name: "Regular", price: 1300 }],
    modifierListIds: [],
    imageId: "5M7NZWS7D3SDKZR3SZSGQHLS",
    price: 1300,
  },
  {
    id: "4RSTJXILEXYRMAE5G7HBH33U",
    name: "Salmon Bites",
    description: "Tender, seasoned salmon pieces seared to perfection.",
    category: "small-plates",
    variations: [{ id: "XQ4WYWNATETSLMFHRVJ55JMJ", name: "Regular", price: 1200 }],
    modifierListIds: [],
    imageId: "GFEDUXWAIRVLUYU7JHXWWAKP",
    price: 1200,
  },
  {
    id: "JKHIPL232KVCLZPRHBCFD5OU",
    name: "Fried Salmon Bites",
    description: "Golden-fried salmon bites with a crispy crust and tender center.",
    category: "small-plates",
    variations: [{ id: "TJ7B6CNYRGPYW5FRKOBLAFPO", name: "Regular", price: 1200 }],
    modifierListIds: [],
    imageId: null,
    price: 1200,
  },
  {
    id: "M5A6T44SU2TEVYJJCUKSFUU7",
    name: "Colossal Fried Shrimp",
    description: "Jumbo shrimp with a golden, crispy coating served with cocktail sauce.",
    category: "small-plates",
    variations: [{ id: "P73BILYW7WGNZIIXF2XDVUUS", name: "Regular", price: 1400 }],
    modifierListIds: [],
    imageId: null,
    price: 1400,
  },
  {
    id: "GCLY3JC3SORR3YDXOJFLAL37",
    name: "Seafood Gumbo",
    description: "Rich and hearty gumbo loaded with shrimp, crab, and andouille sausage.",
    category: "small-plates",
    variations: [{ id: "DW7HZ7N22SLLBBPGPU2NS3QH", name: "Regular", price: 2000 }],
    modifierListIds: [],
    imageId: null,
    price: 2000,
  },
  {
    id: "TZSBXZ57YIQGOMQWKRZP77MJ",
    name: "Crab Fried Rice",
    description: "Savory fried rice loaded with jumbo lump crab meat and fresh vegetables.",
    category: "small-plates",
    variations: [{ id: "7IZ5HWOCBRU263ZKU5XU4FUN", name: "Regular", price: 1600 }],
    modifierListIds: [],
    imageId: null,
    price: 1600,
  },
  {
    id: "XQ2VYFX2PGBV3ZGDX5TQ3VQF",
    name: "Crab Cake Fries",
    description: "Loaded fries topped with lump crab cake, cheese sauce, and Old Bay seasoning.",
    category: "small-plates",
    variations: [{ id: "QL37Y2ZSFWPSEGR63NOWUBTO", name: "Regular", price: 4000 }],
    modifierListIds: [],
    imageId: "GOCCST2QWSTRAGEE6OHM7HDU",
    price: 4000,
  },
  {
    id: "5XEQ6FV62RZ7VECDKR2KH67B",
    name: "Surf and Turf Fries",
    description: "Loaded fries topped with steak and seafood — the ultimate indulgence.",
    category: "small-plates",
    variations: [{ id: "4V6CO3QLLYKYZLZDZYSH2BRR", name: "Regular", price: 4000 }],
    modifierListIds: [],
    imageId: "M7JVBN2UDPANVHVLUI53QHP7",
    price: 4000,
  },

  // ── Salads ──
  {
    id: "MCNXBDADU7RTSMXVWOBO4SYY",
    name: "Caesar Salad",
    description: "Crisp romaine lettuce, parmesan, croutons, and house-made Caesar dressing.",
    category: "salads",
    variations: [{ id: "BZB6OY5G4VDRBUP366LBW33O", name: "Regular", price: 1700 }],
    modifierListIds: [],
    imageId: "MY5A5G7TGM4A4BYLZFH247IK",
    price: 1700,
  },
  {
    id: "C7VFONTTFUZ23FDYXNXFEGSL",
    name: "Spinach & Strawberry Salad",
    description: "Fresh baby spinach, ripe strawberries, candied pecans, and strawberry vinaigrette.",
    category: "salads",
    variations: [{ id: "UHNYOUSK5O3TRM5TBGCJ57KU", name: "Regular", price: 1700 }],
    modifierListIds: [],
    imageId: null,
    price: 1700,
  },
  {
    id: "FNLFMIKGH4JZBRFR6ZJHSYWI",
    name: "Proper Garden Salad",
    description: "Mixed greens with seasonal vegetables and house vinaigrette.",
    category: "salads",
    variations: [{ id: "CPQYGDGKUARPAL22AIYICD2J", name: "Regular", price: 1400 }],
    modifierListIds: [],
    imageId: null,
    price: 1400,
  },

  // ── Entrees — Land ──
  {
    id: "HPL26HWWYNI3PL7AA6BBALYD",
    name: "Honey Jerk Lamb Chops",
    description: "Succulent lamb chops glazed with our signature honey jerk sauce. Served with two sides.",
    category: "entrees-land",
    variations: [{ id: "PKJJBZC5LO7WZ6VLCJX6V6LQ", name: "Regular", price: 4000 }],
    modifierListIds: ["R36X2UV64QOYY4K2H7OHLA4K"],
    imageId: "FCYPLZC7VD7F6Y4BNNGPJTUK",
    price: 4000,
  },
  {
    id: "N7J77HTMTAGYCPSYE6UHFKOJ",
    name: "BBQ Jerk Lamb Chops",
    description: "Tender lamb chops with smoky BBQ jerk glaze. Served with two sides.",
    category: "entrees-land",
    variations: [{ id: "LGPD4WIOL4M2A6CTHMYZU5VJ", name: "Regular", price: 3500 }],
    modifierListIds: ["R36X2UV64QOYY4K2H7OHLA4K"],
    imageId: null,
    price: 3500,
  },
  {
    id: "OEHZS56QJTFZZ42SE2XBHHDP",
    name: "Chicken & Waffles",
    description: "Crispy fried chicken atop a golden waffle, drizzled with maple syrup.",
    category: "entrees-land",
    variations: [{ id: "IR24GVMQC2IWG7AMTGCPWJLV", name: "Regular", price: 2000 }],
    modifierListIds: [],
    imageId: null,
    price: 2000,
  },
  {
    id: "5LD5AGUHSIZXIXES7XLKUFMP",
    name: "Oxtails",
    description: "Slow-braised oxtails in rich gravy until fall-off-the-bone tender.",
    category: "entrees-land",
    variations: [{ id: "Y6OBSNJWTQNTSHQIQEPCVGDS", name: "Regular", price: 4000 }],
    modifierListIds: [],
    imageId: null,
    price: 4000,
  },
  {
    id: "47AIRSS6JBX23JRBJZI43J6G",
    name: "NY Strip",
    description: "Premium cut NY Strip steak, cooked to your preference.",
    category: "entrees-land",
    variations: [{ id: "AJ73D3FMLAKSUJ4QHF72NPY7", name: "Regular", price: 3500 }],
    modifierListIds: [],
    imageId: null,
    price: 3500,
  },

  // ── Entrees — Sea ──
  {
    id: "RICWCHC2FMECZC6S2HCTJ4GW",
    name: "Red Snapper",
    description: "Pan-seared red snapper with a crispy skin and delicate flavor. Served with two sides.",
    category: "entrees-sea",
    variations: [{ id: "4QKBLKBCGEPJIHQRBEYZZA6B", name: "Regular", price: 4000 }],
    modifierListIds: ["R36X2UV64QOYY4K2H7OHLA4K"],
    imageId: null,
    price: 4000,
  },
  {
    id: "GR6CUML6RVECFMFCAFPZTTUL",
    name: "Salmon Filet",
    description: "Atlantic salmon filet, perfectly seared with a golden crust. Served with two sides.",
    category: "entrees-sea",
    variations: [
      { id: "SG5AYP7YMD5GPL5CTGJWIBWZ", name: "Regular", price: 3000 },
    ],
    modifierListIds: ["R36X2UV64QOYY4K2H7OHLA4K"],
    imageId: "CSBVSTP5LUV7EQCACNJUDF7S",
    price: 3000,
  },
  {
    id: "AEZI3H23MEVHSBE6SB5LXSO4",
    name: "Jumbo Lump Crab Cake",
    description: "Premium jumbo lump crab cake, pan-seared golden. Served with two sides.",
    category: "entrees-sea",
    variations: [{ id: "HZYPYVLRBPLVRDDV6MZUWUZM", name: "Regular", price: 4500 }],
    modifierListIds: ["R36X2UV64QOYY4K2H7OHLA4K"],
    imageId: "4R27JTLDUH556R6OXXLIO6I6",
    price: 4500,
  },
  {
    id: "NSZRQOVDN4723IUEJN46FS6E",
    name: "Double Lump Crab Cake",
    description: "Two premium jumbo lump crab cakes for the true crab lover. Served with two sides.",
    category: "entrees-sea",
    variations: [{ id: "C6A2CT2GWYXE4X6GEPY3H5PH", name: "Regular", price: 8000 }],
    modifierListIds: ["R36X2UV64QOYY4K2H7OHLA4K"],
    imageId: "GLP44IQANJSKVG6AV3JVMBFN",
    price: 8000,
  },
  {
    id: "ZKGEY4QANOI5GONI7TJGC6ES",
    name: "Cajun Fried Lobster Tail",
    description: "Cajun-seasoned lobster tail, fried to golden perfection. Served with two sides.",
    category: "entrees-sea",
    variations: [{ id: "JVC2YDSFQNJXHS4EU2WZHEL3", name: "Regular", price: 3000 }],
    modifierListIds: ["R36X2UV64QOYY4K2H7OHLA4K"],
    imageId: "GXH6LZE5PXVACZGNOF6OMGIL",
    price: 3000,
  },
  {
    id: "GKGRXCPACY7LEXQE2CLUM6RR",
    name: "Cajun Butter Lobster",
    description: "Succulent lobster bathed in rich Cajun butter sauce. Served with two sides.",
    category: "entrees-sea",
    variations: [{ id: "L2YAQ3FDPYNBDVDR2CEFTIZA", name: "Regular", price: 3000 }],
    modifierListIds: ["R36X2UV64QOYY4K2H7OHLA4K"],
    imageId: "US5CSEIJFTS4CNQKJKHGE4Q6",
    price: 3000,
  },
  {
    id: "IEUDGLDXY46SZXTK5ZRIU2BL",
    name: "Stuffed Salmon",
    description: "Salmon filet stuffed with crab meat and baked to perfection. Served with two sides.",
    category: "entrees-sea",
    variations: [{ id: "7VLZLPNJS73J2Q7VFLTGVL7G", name: "Regular", price: 4000 }],
    modifierListIds: [],
    imageId: null,
    price: 4000,
  },
  {
    id: "RGPE2HUW4EJA2YBSIPFOAYS6",
    name: "Shrimp & Grits",
    description: "Jumbo shrimp over creamy gouda cheddar grits with Cajun butter sauce.",
    category: "entrees-sea",
    variations: [{ id: "ZFAIB7QSGLJ2HLIVPKGYHAVE", name: "Regular", price: 3000 }],
    modifierListIds: [],
    imageId: null,
    price: 3000,
  },
  {
    id: "NKIH5N2YLGZQMZX6Y3R55VNC",
    name: "Crab + Honey Jerk Lamb Chops",
    description: "The best of surf and turf — jumbo lump crab cake paired with honey jerk lamb chops. Served with two sides.",
    category: "entrees-sea",
    variations: [{ id: "N7DMXQM53ZHBUACPXH7VYRIP", name: "Regular", price: 7000 }],
    modifierListIds: ["R36X2UV64QOYY4K2H7OHLA4K"],
    imageId: null,
    price: 7000,
  },
  {
    id: "4N6KXJ22SXLKSF2ZDOSZZ346",
    name: "Crab + BBQ Jerk Lamb Chops",
    description: "Jumbo lump crab cake paired with BBQ jerk lamb chops. Served with two sides.",
    category: "entrees-sea",
    variations: [{ id: "4DBFH57FPT73MLQWXGADD6KQ", name: "Regular", price: 7000 }],
    modifierListIds: ["R36X2UV64QOYY4K2H7OHLA4K"],
    imageId: null,
    price: 7000,
  },
  {
    id: "Q62ZSLOMMMMKHUQF33RU755D",
    name: "Ultimate Surf & Turf Grits",
    description: "Steak, shrimp, and crab over creamy gouda cheddar grits.",
    category: "entrees-sea",
    variations: [{ id: "N7QMSQ6MKHYD55G24HJ2T7EM", name: "Regular", price: 4000 }],
    modifierListIds: [],
    imageId: null,
    price: 4000,
  },
  {
    id: "DCVB77XMMNXBKLD5RULYE4PB",
    name: "Fried Lobster Mac & Cheese",
    description: "Crispy fried lobster pieces over our signature creamy mac and cheese.",
    category: "entrees-sea",
    variations: [{ id: "7JJZRRHH7UKGHKKVXXJOSO4A", name: "Regular", price: 4000 }],
    modifierListIds: [],
    imageId: null,
    price: 4000,
  },

  // ── Pasta ──
  {
    id: "7TRPHJTNV6PVSY557RP5H52I",
    name: "Creamy Salmon Pasta",
    description: "Perfectly seared salmon over creamy pasta with a rich, savory sauce.",
    category: "pasta",
    variations: [{ id: "JBLY5YKVPR3VMLUGGHAYZSBN", name: "Regular", price: 3500 }],
    modifierListIds: [],
    imageId: null,
    price: 3500,
  },
  {
    id: "UZWT6B5OPU36WCKZ53J7YBKK",
    name: "Build Your Own Pasta",
    description: "Choose your protein and we'll craft a custom pasta just for you.",
    category: "pasta",
    variations: [{ id: "DFWQICIOO5D5SDSAAPBCNTBU", name: "Regular", price: 1800 }],
    modifierListIds: ["EAOE3UPUWX5JQE67P4RVBI3L"],
    imageId: "4OQ7HNXSYXJRVTZIKSSCKLFR",
    price: 1800,
  },
  {
    id: "7KEHP5RHHCU557JI7Q34JGAG",
    name: "Ultimate Seafood Pasta",
    description: "Shrimp, lobster, crab, and salmon in a rich cream sauce over fresh pasta.",
    category: "pasta",
    variations: [{ id: "K6DIZCY6SHUPBQEICHJ5PNXT", name: "Regular", price: 5500 }],
    modifierListIds: [],
    imageId: "TBYO5CF4T22UJSUBFUTBGLEI",
    price: 5500,
  },
  {
    id: "ODDSW5WH3MMO5JEVB3EDF2CD",
    name: "Build Your Own Rasta Pasta",
    description: "Choose your protein for our flavorful Caribbean-spiced rasta pasta.",
    category: "pasta",
    variations: [{ id: "SYQQU75QKXJJ35LRBJNKZZDZ", name: "Regular", price: 1800 }],
    modifierListIds: ["EAOE3UPUWX5JQE67P4RVBI3L"],
    imageId: null,
    price: 1800,
  },
  {
    id: "FHPQZGPKHR4SSDJ4HN2O7XUX",
    name: "Rasta Pasta",
    description: "Caribbean-spiced creamy pasta with bell peppers, jerk seasoning, and bold flavor.",
    category: "pasta",
    variations: [{ id: "7X2DJC3HEJ74SX3NL6TXB5GH", name: "Regular", price: 4000 }],
    modifierListIds: [],
    imageId: null,
    price: 4000,
  },
  {
    id: "ABKGPJAZL62QL2ARPKAJDEAQ",
    name: "Rigatoni",
    description: "Hearty rigatoni with your choice of protein in a rich, savory sauce.",
    category: "pasta",
    variations: [{ id: "6YZUEB7D2TSBGHDSOOIVNSZO", name: "Regular", price: 3000 }],
    modifierListIds: ["EAOE3UPUWX5JQE67P4RVBI3L"],
    imageId: null,
    price: 3000,
  },

  // ── Sandwiches ──
  {
    id: "DFJEDKVVRSPYYYUM7R554W2H",
    name: "Crab Cake Sandwich",
    description: "Premium lump crab cake on a toasted brioche bun with lettuce, tomato, and remoulade.",
    category: "sandwiches",
    variations: [{ id: "A73JXOYC32NDB2QYCY75WM47", name: "Regular", price: 4000 }],
    modifierListIds: [],
    imageId: null,
    price: 4000,
  },

  // ── Sides ──
  {
    id: "XQHTXYJ2VVYM7MTZSXNKFQKT",
    name: "Mac & Cheese",
    description: "Creamy, rich mac and cheese made with a blend of premium cheeses.",
    category: "sides",
    variations: [{ id: "S6XVZXL3GMVRQP76IY4WPRZS", name: "Regular", price: 1000 }],
    modifierListIds: [],
    imageId: null,
    price: 1000,
  },
  {
    id: "2JBKQDB4SGUY5YAPD3B37ARX",
    name: "Mash Potatoes",
    description: "Smooth, buttery mashed potatoes.",
    category: "sides",
    variations: [{ id: "LJVROMLHCCOCNQLNLYP4C47K", name: "Regular", price: 700 }],
    modifierListIds: [],
    imageId: null,
    price: 700,
  },
  {
    id: "NZBOM3PROELEHFSQZXEYNYCQ",
    name: "Fries",
    description: "Golden, crispy seasoned fries.",
    category: "sides",
    variations: [{ id: "RSKQNBYOMT3JO7OYNRJ6P4FL", name: "Regular", price: 700 }],
    modifierListIds: [],
    imageId: null,
    price: 700,
  },
  {
    id: "J3YUZVJR7EF3WJFQFEVZHX5R",
    name: "Roasted Asparagus",
    description: "Tender asparagus spears roasted with garlic and olive oil.",
    category: "sides",
    variations: [{ id: "ZAFTSRF67UCMA4OUPNOM4WP6", name: "Regular", price: 700 }],
    modifierListIds: [],
    imageId: null,
    price: 700,
  },
  {
    id: "OJP2AKVF6BAQN7KVSTRX476M",
    name: "Slow Cooked Kale",
    description: "Southern-style kale, slow-cooked with smoky seasonings.",
    category: "sides",
    variations: [{ id: "K7XWXFIJKS5MCGNO4I6BQSRC", name: "Regular", price: 700 }],
    modifierListIds: [],
    imageId: null,
    price: 700,
  },
  {
    id: "Y3LLJKKPMN7OQUJT2UZENUJJ",
    name: "Roasted Broccolini",
    description: "Tender broccolini roasted with garlic and lemon.",
    category: "sides",
    variations: [{ id: "RYEVHFVQ46RNO3TWH6B67OSW", name: "Regular", price: 700 }],
    modifierListIds: [],
    imageId: null,
    price: 700,
  },
  {
    id: "CZ47IEFR4VTLFMC5HDLQGRGA",
    name: "Veggie Medley",
    description: "Seasonal vegetables sautéed to perfection.",
    category: "sides",
    variations: [{ id: "HUOCONCLX77ADEKUPRMFW6MK", name: "Regular", price: 1000 }],
    modifierListIds: [],
    imageId: null,
    price: 1000,
  },
  {
    id: "7SN3B36B6VICMRW5LREXEM46",
    name: "Gouda Cheddar Grits",
    description: "Creamy grits with gouda and sharp cheddar cheese.",
    category: "sides",
    variations: [{ id: "UGDPGGYFZCAJTM6Q2IFWU4IC", name: "Regular", price: 1000 }],
    modifierListIds: [],
    imageId: null,
    price: 1000,
  },
  {
    id: "YAGKLAZAS3UJWNZ5MUBZJ3JJ",
    name: "Rice",
    description: "Fluffy seasoned white rice.",
    category: "sides",
    variations: [{ id: "FCSW2E3VZLGWO5LVBONA3BIH", name: "Regular", price: 700 }],
    modifierListIds: [],
    imageId: null,
    price: 700,
  },

  // ── Desserts ──
  {
    id: "U7FOLK6MSNBQPS63HWLJL4T7",
    name: "Sweet Potato Pound Cake",
    description: "Warm sweet potato pound cake served with a scoop of vanilla ice cream.",
    category: "desserts",
    variations: [{ id: "MGRCC7UMNQCPHLEQ73OCXJ7S", name: "Regular", price: 1500 }],
    modifierListIds: [],
    imageId: null,
    price: 1500,
  },
  {
    id: "LFG2ZLRSCM6KZYU47DEOM7MG",
    name: "Lava Cake",
    description: "Warm chocolate lava cake with a molten center.",
    category: "desserts",
    variations: [{ id: "T5EFB3ALRTS4JOYRZ4P22HHP", name: "Regular", price: 1350 }],
    modifierListIds: [],
    imageId: null,
    price: 1350,
  },
  {
    id: "56FKWG5XYNS62HZ6IEUSXYRO",
    name: "Lava Cake with Ice Cream",
    description: "Warm chocolate lava cake topped with a scoop of premium vanilla ice cream.",
    category: "desserts",
    variations: [{ id: "GDOK3OTMCSTE35PQNW6HE7Q6", name: "Regular", price: 2000 }],
    modifierListIds: [],
    imageId: null,
    price: 2000,
  },
  {
    id: "KUJFFTNBRXCILLMZFYBMWQ23",
    name: "Apple Turnover with Ice Cream",
    description: "Flaky golden apple turnover served warm with vanilla ice cream.",
    category: "desserts",
    variations: [{ id: "XJ54QAZ6QWSIIQNYV25GUO4M", name: "Regular", price: 2000 }],
    modifierListIds: [],
    imageId: null,
    price: 2000,
  },

  // ── Drinks (Non-Alcoholic) ──
  {
    id: "LNWA2EMJGYDVCDRABFFB6WBY",
    name: "Mango Lemonade",
    description: "Refreshing house-made lemonade with tropical mango.",
    category: "drinks",
    variations: [{ id: "NDRT7L5IY3HO7IISOKCNW5FT", name: "Regular", price: 1000 }],
    modifierListIds: [],
    imageId: null,
    price: 1000,
  },
];

export function formatPrice(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export function getModifierList(id: string): ModifierList | undefined {
  return MODIFIER_LISTS.find((ml) => ml.id === id);
}

export function getMenuItemsByCategory(category: CategorySlug): MenuItem[] {
  return MENU_ITEMS.filter((item) => item.category === category);
}
