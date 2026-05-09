// Curated allow-list of Phosphor icons that admins can pick from for
// tags + that the kid client renders. Keep the set kid-relevant:
// emotion / tone, royalty / achievement, action / adventure,
// mystery / spooky, sci-fi / games, music / arts, education,
// animals, nature, weather, food, travel, misc.
//
// Add new entries by their bare Phosphor name (the export name from
// @phosphor-icons/react). The kid client maps unknown names to no
// icon, so a typo on the admin side renders cleanly.

import {
    Airplane,
    Alien,
    Anchor,
    Bicycle,
    Bird,
    Boat,
    Book,
    BookOpen,
    Books,
    Brain,
    Bug,
    Bus,
    Butterfly,
    Cake,
    Calculator,
    Camera,
    Car,
    Cat,
    Cloud,
    CloudLightning,
    CloudRain,
    Coffee,
    Compass,
    Confetti,
    Cookie,
    Cow,
    Crown,
    CrownSimple,
    Detective,
    Diamond,
    Dog,
    Eye,
    Eyes,
    FilmReel,
    FilmSlate,
    Fire,
    FireSimple,
    Fish,
    Flower,
    ForkKnife,
    GameController,
    Ghost,
    Gift,
    Globe,
    GraduationCap,
    Hamburger,
    Heart,
    HeartBreak,
    Horse,
    IceCream,
    Lightbulb,
    Lightning,
    MagnifyingGlass,
    MaskHappy,
    MaskSad,
    Medal,
    Microphone,
    Moon,
    Mountains,
    MusicNote,
    MusicNotes,
    PaintBrush,
    Palette,
    PawPrint,
    Pizza,
    Plant,
    PuzzlePiece,
    Rainbow,
    Robot,
    Rocket,
    Sailboat,
    Shield,
    ShieldStar,
    ShootingStar,
    Skull,
    Smiley,
    SmileyBlank,
    SmileyMeh,
    SmileyNervous,
    SmileySad,
    SmileyWink,
    SmileyXEyes,
    Snowflake,
    Sparkle,
    Star,
    StarFour,
    Sun,
    Sword,
    Train,
    Tree,
    TreeEvergreen,
    TreePalm,
    Trophy,
    Truck,
    type IconProps,
} from "@phosphor-icons/react";
import type { ComponentType } from "react";

export type TagIconName =
    | "Heart"
    | "HeartBreak"
    | "Star"
    | "StarFour"
    | "Sparkle"
    | "Smiley"
    | "SmileyXEyes"
    | "SmileyMeh"
    | "SmileyWink"
    | "SmileyBlank"
    | "SmileyNervous"
    | "SmileySad"
    | "Crown"
    | "CrownSimple"
    | "Trophy"
    | "Medal"
    | "Diamond"
    | "Lightning"
    | "Fire"
    | "FireSimple"
    | "Sword"
    | "Shield"
    | "ShieldStar"
    | "MagnifyingGlass"
    | "Detective"
    | "Compass"
    | "ShootingStar"
    | "Anchor"
    | "Ghost"
    | "Skull"
    | "Eye"
    | "Eyes"
    | "MaskHappy"
    | "MaskSad"
    | "Rocket"
    | "Robot"
    | "Alien"
    | "GameController"
    | "PuzzlePiece"
    | "MusicNote"
    | "MusicNotes"
    | "Microphone"
    | "PaintBrush"
    | "Palette"
    | "Camera"
    | "FilmReel"
    | "FilmSlate"
    | "Book"
    | "Books"
    | "BookOpen"
    | "GraduationCap"
    | "Globe"
    | "Lightbulb"
    | "Brain"
    | "Calculator"
    | "PawPrint"
    | "Cat"
    | "Dog"
    | "Bird"
    | "Fish"
    | "Butterfly"
    | "Bug"
    | "Cow"
    | "Horse"
    | "Flower"
    | "Tree"
    | "TreePalm"
    | "TreeEvergreen"
    | "Mountains"
    | "Plant"
    | "Sun"
    | "Moon"
    | "Cloud"
    | "Rainbow"
    | "Snowflake"
    | "CloudRain"
    | "CloudLightning"
    | "Cake"
    | "Pizza"
    | "IceCream"
    | "Cookie"
    | "Hamburger"
    | "Coffee"
    | "ForkKnife"
    | "Airplane"
    | "Car"
    | "Boat"
    | "Train"
    | "Bicycle"
    | "Bus"
    | "Truck"
    | "Sailboat"
    | "Gift"
    | "Confetti";

export const TAG_ICONS: Record<TagIconName, ComponentType<IconProps>> = {
    Heart,
    HeartBreak,
    Star,
    StarFour,
    Sparkle,
    Smiley,
    SmileyXEyes,
    SmileyMeh,
    SmileyWink,
    SmileyBlank,
    SmileyNervous,
    SmileySad,
    Crown,
    CrownSimple,
    Trophy,
    Medal,
    Diamond,
    Lightning,
    Fire,
    FireSimple,
    Sword,
    Shield,
    ShieldStar,
    MagnifyingGlass,
    Detective,
    Compass,
    ShootingStar,
    Anchor,
    Ghost,
    Skull,
    Eye,
    Eyes,
    MaskHappy,
    MaskSad,
    Rocket,
    Robot,
    Alien,
    GameController,
    PuzzlePiece,
    MusicNote,
    MusicNotes,
    Microphone,
    PaintBrush,
    Palette,
    Camera,
    FilmReel,
    FilmSlate,
    Book,
    Books,
    BookOpen,
    GraduationCap,
    Globe,
    Lightbulb,
    Brain,
    Calculator,
    PawPrint,
    Cat,
    Dog,
    Bird,
    Fish,
    Butterfly,
    Bug,
    Cow,
    Horse,
    Flower,
    Tree,
    TreePalm,
    TreeEvergreen,
    Mountains,
    Plant,
    Sun,
    Moon,
    Cloud,
    Rainbow,
    Snowflake,
    CloudRain,
    CloudLightning,
    Cake,
    Pizza,
    IceCream,
    Cookie,
    Hamburger,
    Coffee,
    ForkKnife,
    Airplane,
    Car,
    Boat,
    Train,
    Bicycle,
    Bus,
    Truck,
    Sailboat,
    Gift,
    Confetti,
};

// Display order for the picker. Loose visual groupings: emotional /
// tone, royalty, action, mystery, sci-fi, music, education, animals,
// nature, weather, food, travel, misc.
export const TAG_ICON_ORDER: TagIconName[] = [
    "Heart",
    "HeartBreak",
    "Star",
    "StarFour",
    "Sparkle",
    "Smiley",
    "SmileyWink",
    "SmileyXEyes",
    "SmileyMeh",
    "SmileyNervous",
    "SmileySad",
    "SmileyBlank",
    "Crown",
    "CrownSimple",
    "Trophy",
    "Medal",
    "Diamond",
    "Lightning",
    "Fire",
    "FireSimple",
    "Sword",
    "Shield",
    "ShieldStar",
    "MagnifyingGlass",
    "Detective",
    "Compass",
    "ShootingStar",
    "Anchor",
    "Ghost",
    "Skull",
    "Eye",
    "Eyes",
    "MaskHappy",
    "MaskSad",
    "Rocket",
    "Robot",
    "Alien",
    "GameController",
    "PuzzlePiece",
    "MusicNote",
    "MusicNotes",
    "Microphone",
    "PaintBrush",
    "Palette",
    "Camera",
    "FilmReel",
    "FilmSlate",
    "Book",
    "Books",
    "BookOpen",
    "GraduationCap",
    "Globe",
    "Lightbulb",
    "Brain",
    "Calculator",
    "PawPrint",
    "Cat",
    "Dog",
    "Bird",
    "Fish",
    "Butterfly",
    "Bug",
    "Cow",
    "Horse",
    "Flower",
    "Tree",
    "TreePalm",
    "TreeEvergreen",
    "Mountains",
    "Plant",
    "Sun",
    "Moon",
    "Cloud",
    "Rainbow",
    "Snowflake",
    "CloudRain",
    "CloudLightning",
    "Cake",
    "Pizza",
    "IceCream",
    "Cookie",
    "Hamburger",
    "Coffee",
    "ForkKnife",
    "Airplane",
    "Car",
    "Boat",
    "Train",
    "Bicycle",
    "Bus",
    "Truck",
    "Sailboat",
    "Gift",
    "Confetti",
];

export function isTagIconName(s: string | null | undefined): s is TagIconName {
    return !!s && Object.prototype.hasOwnProperty.call(TAG_ICONS, s);
}
