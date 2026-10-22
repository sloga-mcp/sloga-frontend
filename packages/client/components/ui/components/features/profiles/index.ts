import { ProfileActions } from "./ProfileActions";
import { CipherBadgePreview, ProfileBadges } from "./ProfileBadges";
import { ProfileBanner } from "./ProfileBanner";
import { ProfileBio } from "./ProfileBio";

export { isProfilePrivateError } from "./ProfileBio";
import { ProfileCard } from "./ProfileCard";
import { ProfileConnections } from "./ProfileConnections";
import { ProfileGameIds } from "./ProfileGameIds";
import { ProfileJoined } from "./ProfileJoined";
import { ProfileMutuals } from "./ProfileMutuals";
import { ProfileRespect } from "./ProfileRespect";
import { ProfileRoles } from "./ProfileRoles";
import { ProfileStatus } from "./ProfileStatus";

export { LINK_PLATFORM_NAMES } from "./ProfileGameIds";

export const Profile = {
  Actions: ProfileActions,
  Badges: ProfileBadges,
  Banner: ProfileBanner,
  Bio: ProfileBio,
  Card: ProfileCard,
  CipherPreview: CipherBadgePreview,
  Connections: ProfileConnections,
  GameIds: ProfileGameIds,
  Joined: ProfileJoined,
  Mutuals: ProfileMutuals,
  Respect: ProfileRespect,
  Roles: ProfileRoles,
  Status: ProfileStatus,
};
