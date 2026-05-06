// Curated allow-list of Phosphor icons that admins can pick from for
// tags + that the kid client renders. Keep the set small and broadly
// kid-relevant: too many options and the picker becomes overwhelming;
// too narrow and admins can't express obvious genres.
//
// "Heart" is reserved for the Favorites row but admins can still pick
// it for a tag - that just means the tag carries the same heart
// styling.
//
// Add new entries by their bare Phosphor name (the export name from
// @phosphor-icons/react). The kid client maps unknown names to no
// icon, so a typo on the admin side renders cleanly.

import {
    Book,
    Cake,
    Crown,
    Detective,
    FilmReel,
    FireSimple,
    Flower,
    GameController,
    Ghost,
    GraduationCap,
    Heart,
    Lightning,
    MagnifyingGlass,
    Moon,
    MusicNote,
    PaintBrush,
    PawPrint,
    Pizza,
    Robot,
    Rocket,
    SmileyXEyes,
    Snowflake,
    Sparkle,
    Star,
    Sun,
    Sword,
    TreePalm,
    Trophy,
    type IconProps,
} from "@phosphor-icons/react";
import type { ComponentType } from "react";

export type TagIconName =
    | "Star"
    | "Heart"
    | "Sparkle"
    | "Crown"
    | "Sun"
    | "Moon"
    | "Ghost"
    | "Cake"
    | "MusicNote"
    | "Lightning"
    | "Book"
    | "GraduationCap"
    | "Rocket"
    | "PawPrint"
    | "GameController"
    | "Sword"
    | "Robot"
    | "Trophy"
    | "Snowflake"
    | "Flower"
    | "TreePalm"
    | "MagnifyingGlass"
    | "Detective"
    | "SmileyXEyes"
    | "FireSimple"
    | "FilmReel"
    | "PaintBrush"
    | "Pizza";

export const TAG_ICONS: Record<TagIconName, ComponentType<IconProps>> = {
    Star,
    Heart,
    Sparkle,
    Crown,
    Sun,
    Moon,
    Ghost,
    Cake,
    MusicNote,
    Lightning,
    Book,
    GraduationCap,
    Rocket,
    PawPrint,
    GameController,
    Sword,
    Robot,
    Trophy,
    Snowflake,
    Flower,
    TreePalm,
    MagnifyingGlass,
    Detective,
    SmileyXEyes,
    FireSimple,
    FilmReel,
    PaintBrush,
    Pizza,
};

// Display order for the picker. Roughly: emotional / tone first, then
// genres, then food / weather / etc. The admin picker grid lays them
// out left-to-right in this sequence.
export const TAG_ICON_ORDER: TagIconName[] = [
    "Heart",
    "Star",
    "Sparkle",
    "SmileyXEyes",
    "Crown",
    "Trophy",
    "Lightning",
    "FireSimple",
    "Sword",
    "Ghost",
    "MagnifyingGlass",
    "Detective",
    "Rocket",
    "Robot",
    "GameController",
    "MusicNote",
    "FilmReel",
    "PaintBrush",
    "Book",
    "GraduationCap",
    "PawPrint",
    "Flower",
    "TreePalm",
    "Sun",
    "Moon",
    "Snowflake",
    "Cake",
    "Pizza",
];

export function isTagIconName(s: string | null | undefined): s is TagIconName {
    return !!s && Object.prototype.hasOwnProperty.call(TAG_ICONS, s);
}
