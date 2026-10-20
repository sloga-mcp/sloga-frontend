import { Trans } from "@lingui-solid/solid/macro";
import { styled } from "styled-system/jsx";

import { useClient } from "@revolt/client";
import { useModals } from "@revolt/modal";
import { useNavigate } from "@revolt/routing";
import { CategoryButton } from "@revolt/ui";

import MdAddCircle from "@material-design-icons/svg/filled/add_circle.svg?component-solid";
import MdExplore from "@material-design-icons/svg/filled/explore.svg?component-solid";
import MdMoveDown from "@material-design-icons/svg/filled/move_down.svg?component-solid";
import MdPersonAdd from "@material-design-icons/svg/filled/person_add.svg?component-solid";

const Section = styled("section", {
  base: {
    display: "flex",
    flexDirection: "column",
    gap: "4px",
    color: "var(--md-sys-color-on-surface)",
  },
});

const Title = styled("h2", {
  base: {
    margin: 0,
    fontSize: "22px",
    fontWeight: 800,
    lineHeight: 1.2,
  },
});

const Subtitle = styled("p", {
  base: {
    margin: "0 0 8px",
    fontSize: "14px",
    color: "var(--md-sys-color-on-surface-variant)",
  },
});

const Grid = styled("div", {
  base: {
    display: "grid",
    gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
    gap: "8px",

    "@media (max-width: 640px)": {
      gridTemplateColumns: "minmax(0, 1fr)",
    },
  },
});

/**
 * First steps for an account with no servers or no friends yet. Importing a
 * server comes first: it is the fastest way to arrive with a community.
 */
export function WelcomeTiles() {
  const client = useClient();
  const { openModal } = useModals();
  const navigate = useNavigate();

  return (
    <Section aria-labelledby="home-welcome-title">
      <Title id="home-welcome-title">
        <Trans>Welcome to Sloga</Trans>
      </Title>
      <Subtitle>
        <Trans>A few ways to get started.</Trans>
      </Subtitle>
      <Grid>
        <div
          style={{
            "--md-sys-color-primary": "#00B2FF",
            "--md-sys-color-on-primary": "#05090F",
          }}
        >
          <CategoryButton
            variant="filled"
            onClick={() =>
              openModal({ type: "import_source", client: client()! })
            }
            description={<Trans>Import from Discord, Stoat or Fluxer.</Trans>}
            icon={<MdMoveDown />}
          >
            <Trans>Bring your server</Trans>
          </CategoryButton>
        </div>
        <CategoryButton
          onClick={() => openModal({ type: "add_friend", client: client()! })}
          description={<Trans>Find people by their username.</Trans>}
          icon={<MdPersonAdd />}
        >
          <Trans>Add a friend</Trans>
        </CategoryButton>
        <CategoryButton
          onClick={() => navigate("/discover")}
          description={<Trans>Browse communities by interest.</Trans>}
          icon={<MdExplore />}
        >
          <Trans>Discover communities</Trans>
        </CategoryButton>
        <CategoryButton
          onClick={() =>
            openModal({ type: "create_group_or_server", client: client()! })
          }
          description={<Trans>Start your own space for your friends.</Trans>}
          icon={<MdAddCircle />}
        >
          <Trans>Create a server</Trans>
        </CategoryButton>
      </Grid>
    </Section>
  );
}
