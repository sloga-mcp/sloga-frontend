import { TrackReference } from "solid-livekit-components";
import {
  API,
  Bot,
  Channel,
  Client,
  Emoji,
  File,
  ImageEmbed,
  Message,
  MFA,
  MFATicket,
  PublicBot,
  PublicChannelInvite,
  Server,
  ServerMember,
  ServerRole,
  Session,
  User,
  VideoEmbed,
} from "stoat.js";
import { ProtocolV1 } from "stoat.js/lib/events/v1";

import type { SettingsConfigurations } from "@revolt/app";
import { CategoryData } from "@revolt/app/menus/CategoryContextMenu";
import { ScreenShareQualityName } from "@revolt/state/stores/Voice";

import type { ChangelogResponse } from "./modals/Changelog";

export type Modals =
  | {
      type: "add_bot";
      invite: PublicBot;
    }
  | {
      type: "add_friend";
      client: Client;
    }
  | {
      type: "add_members_to_group";
      client: Client;
      group: Channel;
    }
  | {
      type: "ban_member";
      member: ServerMember;
    }
  | {
      type: "ban_non_member";
      user: User;
      server: Server;
    }
  | {
      type: "suspend_user";
      user: User;
      client: Client;
    }
  | {
      type: "changelog";
      changelog: ChangelogResponse;
    }
  | {
      type: "changelog_history";
      changelogs: ChangelogResponse[];
    }
  | {
      type: "channel_info";
      channel: Channel;
    }
  | {
      type: "channel_toggle_mature";
      channel: Channel;
    }
  | {
      type: "create_bot";
      client: Client;
      onCreate: (bot: Bot) => void;
    }
  | {
      type: "create_category";
      server: Server;
    }
  | {
      type: "create_channel";
      server: Server;
      cb?: (channel: Channel) => void;
    }
  | {
      type: "create_group";
      client: Client;
    }
  | {
      type: "create_thread";
      /** Parent text channel the thread will hang off */
      channel: Channel;
      /** Message to anchor the thread to, if created from a message */
      message?: Message;
    }
  | {
      type: "create_forum_post";
      /** Forum channel the post will be created in */
      channel: Channel;
    }
  | {
      type: "create_poll";
      /** Channel the poll will be posted to */
      channel: Channel;
    }
  | {
      type: "poll_voters";
      /** Poll message whose ballots to list (author / moderator only) */
      message: Message;
    }
  | {
      type: "forward_message";
      /** Message to forward (server copies an immutable snapshot) */
      message: Message;
    }
  | {
      type: "schedule_message";
      /** Channel whose current draft should be scheduled */
      channel: Channel;
    }
  | {
      type: "follow_channel";
      /** Announcement channel to follow from another server's channel */
      channel: Channel;
    }
  | {
      type: "create_role";
      server: Server;
      callback: (id: string) => void;
    }
  | {
      type: "create_or_join_server";
      client: Client;
    }
  | {
      type: "create_group_or_server";
      client: Client;
    }
  | {
      type: "create_invite";
      channel: Channel;
    }
  | {
      type: "invite_to_server";
      server: Server;
    }
  | {
      type: "create_server";
      client: Client;
    }
  | {
      type: "create_webhook";
      channel: Channel;
      callback: (id: string) => void;
    }
  | {
      type: "custom_status";
      client: Client;
    }
  | {
      type: "delete_bot";
      bot: Bot;
    }
  | {
      type: "delete_channel";
      channel: Channel;
    }
  | {
      type: "delete_category";
      server: Server;
      categoryId: string;
    }
  | {
      type: "delete_message";
      message: Message;
    }
  | {
      type: "delete_server";
      server: Server;
    }
  | {
      type: "delete_role";
      role: ServerRole;
      cb: () => void;
    }
  | {
      type: "edit_email";
      client: Client;
    }
  | {
      type: "edit_password";
      client: Client;
    }
  | {
      type: "edit_username";
      client: Client;
    }
  | {
      type: "emoji_preview";
      emoji: Emoji;
    }
  | {
      type: "error2";

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      error: any;
    }
  | {
      type: "e2ee_identity_change";
      peerUserId: string;
    }
  | {
      type: "e2ee_verify";
      peerUserId: string;
      /**
       * Where the screen was opened from (slice 6.5 FE-10). `"call"` = the
       * call roster panel: use call-context fallback copy and HIDE the
       * DM-only "turn off encryption for this conversation" button (which
       * no-ops without a DM channel and is dangerously adjacent to the call
       * downgrade). Default (undefined) = the DM verification entry point.
       */
      context?: "call";
    }
  | {
      type: "e2ee_enable_group";
      channelId: string;
    }
  | {
      type: "e2ee_enable";
      /**
       * Lead with the restore-vs-start-fresh choice (slice 5.5). Set when the
       * shell auto-opens this for a returning user on a new device — an
       * unprovisioned device whose account previously opted into E2EE (design
       * §6.1). Omitted for the ordinary settings opt-in, which still exposes
       * "Restore from a recovery code" as a secondary action.
       */
      offerRestore?: boolean;
    }
  | {
      /**
       * §6.4 revoked-device re-enroll. Shown for a returning device whose
       * server-side identity row was revoked while it was dead: the restore
       * succeeded locally but the post-restore claim was rejected, so the
       * restored keys must be re-published as a first publication under a
       * second MFA ticket. Auto-opened by the shell on `e2ee.reenrollNeeded`.
       */
      type: "e2ee_reenroll";
    }
  | {
      type: "e2ee_disable";
    }
  | {
      type: "image_viewer";
      embed?: ImageEmbed;
      gif?: VideoEmbed;
      file?: File;
    }
  | {
      type: "join_server";
      client: Client;
    }
  | {
      type: "kick_member";
      member: ServerMember;
    }
  | {
      type: "leave_server";
      server: Server;
    }
  | {
      type: "mfa_enable_totp";
      identifier: string;
      secret: string;
      callback: (code?: string) => void;
    }
  | ({
      type: "mfa_flow";
    } & (
      | {
          mfa: MFA;
          state: "known";
          callback: (ticket?: MFATicket) => void;
        }
      | {
          state: "unknown";
          available_methods: API.MFAMethod[];
          callback: (response?: API.MFAResponse) => void;
        }
    ))
  | { type: "mfa_recovery"; codes: string[]; mfa: MFA }
  | {
      type: "onboarding";
      callback: (username: string, loginAfterSuccess?: true) => Promise<void>;
    }
  | {
      type: "policy_change";
      changes: ProtocolV1["types"]["policyChange"][];
      acknowledge: () => Promise<void>;
    }
  | {
      type: "rename_session";
      session: Session;
    }
  | {
      type: "report_content";
      client: Client;
      target: Server | User | Message;
      contextMessage?: Message;
    }
  | {
      type: "report_queue";
      client: Client;
    }
  | {
      type: "server_identity";
      member: ServerMember;
    }
  | {
      type: "server_info";
      server: Server;
    }
  | {
      type: "invite";
      invite: PublicChannelInvite;
    }
  | {
      type: "settings";
      config: keyof typeof SettingsConfigurations;
      // eslint-disable-next-line
      context?: any;
    }
  | {
      type: "signed_out";
    }
  | {
      type: "sign_out_sessions";
      client: Client;
    }
  // unimplemented: (modals.tsx#L58)
  | {
      type: "report_success";
      user?: User;
    }
  | {
      type: "out_of_date";
      version: string;
    }
  | {
      type: "reset_bot_token";
      bot: Bot;
    }
  | {
      type: "link_warning";
      url: URL;
      display: string;
    }
  // | {
  //     type: "pending_friend_requests";
  //     users: User[];
  //   }
  | {
      type: "user_picker";
      omit?: string[];
      callback: (users: string[]) => Promise<void>;
    }
  | {
      type: "user_profile";
      user: User;
      isPlaceholder?: boolean;
      placeholderProfile?: API.UserProfile;
      member?: ServerMember;
    }
  | {
      type: "user_profile_roles";
      member: ServerMember;
    }
  | {
      type: "user_profile_mutual_friends";
      users: User[];
      server?: Server;
    }
  | {
      type: "user_profile_mutual_groups";
      groups: (Server | Channel)[];
    }
  | {
      type: "leave_group";
      channel: Channel;
    }
  | {
      type: "close_dm";
      channel: Channel;
    }
  | {
      type: "unfriend_user";
      user: User;
    }
  | {
      type: "block_user";
      user: User;
    }
  | {
      type: "import_theme";
    }
  | {
      type: "edit_category";
      server: Server;
      category: CategoryData;
    }
  | {
      type: "remove_member";
      group: Channel;
      user: User;
    }
  | {
      type: "screen_share_settings";
      trackReference: TrackReference;
      qualities: { name: string; fullName: string }[];
      audio: boolean;
      callback: (qualityName: ScreenShareQualityName, audio: boolean) => void;
      onCancel: () => void;
    }
  | {
      type: "screen_share_picker";
      callback: (
        idx: number,
        qualityName: ScreenShareQualityName,
        audio: boolean,
      ) => void;
      qualities: { name: string; fullName: string }[];
      sources: {
        idx: number;
        name: string;
        isFullScreen: boolean;
        image?: string;
      }[];
      onCancel: () => void;
    }
  | {
      type: "camera_settings";
    };
