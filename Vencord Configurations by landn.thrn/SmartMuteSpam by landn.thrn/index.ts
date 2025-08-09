/*
 * OnePingExtended — per-channel (guild) + per-author (DM) throttling
 *  - 4 pings per 1 minute (defaults, editable in settings)
 *  - Guilds: per channel
 *  - DMs: per author (user & group)
 *  - Resets on read (CHANNEL_ACK) or after 10 minutes cooldown
 *  - "Allow Mentions" / "Allow Everyone" bypass throttle (guilds + group DMs)
 */

import definePlugin, { OptionType } from "@utils/types";
import { definePluginSettings } from "@api/Settings";
import { ChannelStore, ReadStateStore, FluxDispatcher, UserStore } from "@webpack/common";
import { findByProps /* , findByPropsLazy, findByCode */ } from "@webpack";

type ChannelId = string;
type UserId = string;

const enum ChannelType { GUILD_TEXT = 0, DM = 1, GROUP_DM = 3, GUILD_THREAD = 11 }

const settings = definePluginSettings({
  dmTypesToAffect: {
    type: OptionType.SELECT,
    description: "Select the type of DM for the plugin to affect",
    options: [
      { label: "Both", value: "both" },
      { label: "User DMs", value: "user_dm" },
      { label: "Group DMs", value: "group_dm" }
    ],
    default: "both"
  },

  // Bypass toggles — apply to Guilds and Group DMs as well
  allowMentions: {
    type: OptionType.BOOLEAN,
    description: "Always allow audio pings when you are @mentioned",
    default: false
  },
  allowEveryone: {
    type: OptionType.BOOLEAN,
    description: "Always allow audio pings for @everyone / @here (Server Channels, & Group DMs)",
    default: false
  },

  includeServers: {
    type: OptionType.BOOLEAN,
    description: "Apply to servers, (Per Channel)",
    default: true
  },

  // Throttle knobs 
  pingCountTrigger: {
    type: OptionType.NUMBER,
    description: "How many pings allowed before mute is triggered",
    default: 4, min: 1, max: 10
  },
  windowMinutes: {
    type: OptionType.NUMBER,
    description: "The window of time for your max pings number to trigger the mute, so say if your max pings number is set to 4 and window minutes 1, then that means 4 messages sent within 1 minute triggers mute ",
    default: 1, min: 1, max: 10
  },
  cooldownMinutes: {
    type: OptionType.NUMBER,
    description: "The time it takes for the mute to be unmuted again",
    default: 10, min: 1, max: 120
  },

  resetMode: {
    type: OptionType.SELECT,
    description: "Choose how the mute counter resets",
    options: [
      { label: "Read Messages", value: "read" },
      { label: "Click on Channel", value: "focus" }
    ],
    default: "read"
  }
});

// -------- SAFE SOUND HOOK (non-lazy + guarded) --------
const SoundMod =
  findByProps("playSound", "play", "playSoundpack", "stopSound", "setSoundpack") || undefined;

let suppressNextSound = false;
let unpatchPlaySound: (() => void) | null = null;

function patchPlaySound() {
  if (!SoundMod) return;

  const playKey = (["playSound", "play", "playSoundpack"] as const)
    .find(k => typeof (SoundMod as any)[k] === "function");

  if (!playKey) return;

  const orig = (SoundMod as any)[playKey] as (...args: any[]) => any;

  (SoundMod as any)[playKey] = function (...args: any[]) {
    if (suppressNextSound) { suppressNextSound = false; return; }
    return orig.apply(this, args);
  };

  unpatchPlaySound = () => {
    (SoundMod as any)[playKey] = orig;
    unpatchPlaySound = null;
  };
}
// ------------------------------------------------------

interface Counter {
  windowStart: number;
  count: number;
  mutedUntil: number; // epoch ms; 0 = not muted
}

// Guilds: per channel
const guildCounters: Map<ChannelId, Counter> = new Map();

// DMs: per (channel, author)
const dmCounters: Map<ChannelId, Map<UserId, Counter>> = new Map();

const now = () => Date.now();
const winMs = () => settings.store.windowMinutes * 60_000;
const cdMs = () => settings.store.cooldownMinutes * 60_000;

function isDM(chId: string) {
  const ch = ChannelStore.getChannel(chId);
  return ch?.type === ChannelType.DM || ch?.type === ChannelType.GROUP_DM;
}
function isUserDM(chId: string) {
  const ch = ChannelStore.getChannel(chId);
  return ch?.type === ChannelType.DM;
}
function isGroupDM(chId: string) {
  const ch = ChannelStore.getChannel(chId);
  return ch?.type === ChannelType.GROUP_DM;
}
function shouldAffectDM(chId: string) {
  if (isUserDM(chId) && settings.store.dmTypesToAffect === "group_dm") return false;
  if (isGroupDM(chId) && settings.store.dmTypesToAffect === "user_dm") return false;
  return true;
}

function getCounter(map: Map<any, Counter>, key: any): Counter {
  let c = map.get(key);
  if (!c) {
    c = { windowStart: now(), count: 0, mutedUntil: 0 };
    map.set(key, c);
    return c;
  }
  if (now() - c.windowStart >= winMs()) {
    c.windowStart = now();
    c.count = 0;
  }
  return c;
}

function bypassBecauseMention(message: any, channelId: string): boolean {
  if (!settings.store.allowMentions && !settings.store.allowEveryone) return false;

  const me = UserStore.getCurrentUser()?.id;
  const mentionsMe = !!message?.mentions?.some?.((m: any) => m?.id === me);
  const isEveryone = !!message?.mention_everyone || !!message?.mention_here;

  // Mentions bypass everywhere if enabled
  if (settings.store.allowMentions && mentionsMe) return true;

  // @everyone/@here bypass in guilds and group DMs if enabled
  if (settings.store.allowEveryone) {
    if (!isDM(channelId)) return isEveryone;          // guild
    if (isGroupDM(channelId)) return isEveryone;      // group DM
  }

  return false;
}

function applyGuildThrottle(channelId: string) {
  const c = getCounter(guildCounters, channelId);

  // cooldown expiry
  if (c.mutedUntil && now() >= c.mutedUntil) {
    c.mutedUntil = 0;
    c.count = 0;
    c.windowStart = now();
  }
  if (c.mutedUntil) { suppressNextSound = true; return; }

  c.count += 1;
  if (c.count > settings.store.pingCountTrigger) {
    c.mutedUntil = now() + cdMs();
    suppressNextSound = true; // swallow this ping (the one exceeding)
  }
}

function applyDMThrottle(channelId: string, authorId: string) {
  let perAuthor = dmCounters.get(channelId);
  if (!perAuthor) { perAuthor = new Map(); dmCounters.set(channelId, perAuthor); }

  const c = getCounter(perAuthor, authorId);
  if (c.mutedUntil && now() >= c.mutedUntil) {
    c.mutedUntil = 0;
    c.count = 0;
    c.windowStart = now();
  }
  if (c.mutedUntil) { suppressNextSound = true; return; }

  c.count += 1;
  if (c.count > settings.store.pingCountTrigger) {
    c.mutedUntil = now() + cdMs();
    suppressNextSound = true;
  }
}

function onMessageCreate({ message }: any) {
  if (!message) return;
  const channelId: string = message.channel_id;
  const authorId: string | undefined = message.author?.id;
  if (!channelId || !authorId) return;

  // Only act if channel currently unread
  if (!ReadStateStore.hasUnread(channelId)) return;

  // If user enabled bypass and this message qualifies, don't throttle
  if (bypassBecauseMention(message, channelId)) return;

  if (isDM(channelId)) {
    if (!shouldAffectDM(channelId)) return;
    applyDMThrottle(channelId, authorId);   // per-author in DMs
    return;
  }

  if (!settings.store.includeServers) return;
  applyGuildThrottle(channelId);             // per-channel in guilds
}

function shouldResetOnRead() {
  return settings.store.resetMode === "read";
}
function shouldResetOnFocus() {
  return settings.store.resetMode === "focus";
}
function clearForChannel(channelId?: string) {
  if (!channelId) return;
  guildCounters.delete(channelId);
  dmCounters.delete(channelId);
}

function onChannelAck({ channelId }: any) {
  if (!shouldResetOnRead()) return;
  if (!channelId) return;
  clearForChannel(channelId);
}

function onChannelFocus({ channelId }: any) {
  if (!shouldResetOnFocus()) return;
  if (!channelId) return;
  clearForChannel(channelId);
}

function unpatchAll() {
  unpatchPlaySound?.();
  guildCounters.clear();
  dmCounters.clear();
  suppressNextSound = false;
}

export default definePlugin({
  name: "SmartMuteSpam",
  description: "Smart Mute Spam Feature, the perfect meet in the middle for ending annoying notifications, while also feeling like you aren't missing out for too long. Everything is customizable to your liking. * Inspired by OnePingPerDM created by proffdea * ",
  authors: [{ name: "landn.thrn", id: "831735011588964392" }],
  settings,

  start() {
    patchPlaySound();
    FluxDispatcher.subscribe("MESSAGE_CREATE", onMessageCreate);

    // subscribe to both; handlers check your toggle before acting
    FluxDispatcher.subscribe("CHANNEL_ACK", onChannelAck);
    FluxDispatcher.subscribe("CHANNEL_FOCUS", onChannelFocus);
  },
  stop() {
    FluxDispatcher.unsubscribe("MESSAGE_CREATE", onMessageCreate);
    FluxDispatcher.unsubscribe("CHANNEL_ACK", onChannelAck);
    FluxDispatcher.unsubscribe("CHANNEL_FOCUS", onChannelFocus);
    unpatchAll();
  }
});
