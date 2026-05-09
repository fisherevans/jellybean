// Icon glyphs used across override sub-views. weight="fill" matches
// the rest of the kid app's Phosphor usage; the modal's grayscale
// palette dims them without further styling.
import {
    ArrowLeft,
    Check,
    CheckCircle,
    Circle,
    Clock,
    Coffee,
    EyeSlash,
    Moon,
    Sparkle,
    SunDim,
    Tag as TagIcon,
} from "@phosphor-icons/react";

const ICON_SIZE = 18;

export const IconTag = () => <TagIcon size={ICON_SIZE} weight="fill" />;
export const IconHide = () => <EyeSlash size={ICON_SIZE} weight="fill" />;
export const IconCheck = () => <CheckCircle size={ICON_SIZE} weight="fill" />;
export const IconUncheck = () => <Circle size={ICON_SIZE} weight="regular" />;
export const IconClock = () => <Clock size={ICON_SIZE} weight="fill" />;
export const IconMode = () => <Sparkle size={ICON_SIZE} weight="fill" />;
export const IconDim = () => <SunDim size={ICON_SIZE} weight="fill" />;
export const IconWarm = () => <Sparkle size={ICON_SIZE} weight="fill" />;
export const IconBreak = () => <Coffee size={ICON_SIZE} weight="fill" />;
export const IconAutoOff = () => <Moon size={ICON_SIZE} weight="fill" />;
export const IconArrowLeft = () => <ArrowLeft size={16} weight="bold" />;
export const IconConfirmCheck = () => <Check size={16} weight="bold" />;
