import { Trans } from "@lingui-solid/solid/macro";

import { useApi, useClient, useClientLifecycle } from "@revolt/client";
import { CONFIGURATION } from "@revolt/common";
import { useModals } from "@revolt/modal";
import { useNavigate, useParams } from "@revolt/routing";
import { Button, Row, Text, iconSize } from "@revolt/ui";

import MdArrowBack from "@material-design-icons/svg/filled/arrow_back.svg?component-solid";

import { Show } from "solid-js";
import { FlowTitle } from "./Flow";
import { setFlowCheckEmail } from "./FlowCheck";
import { Fields, Form } from "./Form";

/**
 * Flow for creating a new account
 */
export default function FlowCreate() {
  const api = useApi();
  const getClient = useClient();
  const navigate = useNavigate();
  const { code } = useParams();
  const modals = useModals();
  const { login } = useClientLifecycle();

  /**
   * Create an account
   * @param data Form Data
   */
  async function create(data: FormData) {
    const email = data.get("email") as string;
    const password = data.get("new-password") as string;
    const captcha = data.get("captcha") as string;
    const invite = data.get("invite") as string;

    await api.post("/auth/account/create", {
      email,
      password,
      captcha,
      ...(invite ? { invite } : {}),
    });

    const client = getClient();
    if (client.configuration && !client.configuration.features.email) {
      await login(
        {
          email,
          password,
        },
        modals,
      );
      navigate("/login/auth", { replace: true });
    } else {
      setFlowCheckEmail(email);
      navigate("/login/check", { replace: true });
    }
  }

  const isInviteOnly = () => {
    const client = getClient();
    if (client.configured()) {
      return client.configuration?.features.invite_only;
    }
    return false;
  };

  return (
    <>
      <FlowTitle subtitle={<Trans>Create an account</Trans>} emoji="wave">
        <Trans>Hello!</Trans>
      </FlowTitle>
      {/* `code` is already a percent-encoded segment (the router matches
          on URL.pathname), so it is appended as-is: encodeURIComponent
          would double-encode any "%" and the invite would not round-trip. */}
      <Form
        onSubmit={create}
        captcha={CONFIGURATION.HCAPTCHA_SITEKEY}
        handoffPath={`/login/create${code ? "/" + code : ""}`}
      >
        <Fields fields={["email", "new-password"]} />
        <Show when={isInviteOnly()}>
          <Fields fields={[{ field: "invite", value: code }]} />
        </Show>
        {/* Google Play's user-generated-content policy requires that users
            accept the terms of use BEFORE they can create or upload content,
            so this sits on the registration step rather than buried in
            settings. Links open the public pages so they are readable without
            an account. */}
        <Text class="label" size="small">
          {/* Composed of sibling <Trans> fragments on purpose. Nesting the <a>
              tags INSIDE a single <Trans> renders each link's text three times
              under @lingui-solid — which is why no such usage exists anywhere
              else in this codebase. Do not "tidy" this back into one Trans. */}
          <Trans>By registering you agree to our</Trans>{" "}
          <a
            href="https://sloga.gg/legal/terms.html"
            target="_blank"
            rel="noopener noreferrer"
          >
            <Trans>Terms of Service</Trans>
          </a>{" "}
          <Trans>and</Trans>{" "}
          <a
            href="https://sloga.gg/legal/privacy.html"
            target="_blank"
            rel="noopener noreferrer"
          >
            <Trans>Privacy Policy</Trans>
          </a>
          .
        </Text>
        <Row justify>
          <a href="..">
            <Button variant="text">
              <MdArrowBack {...iconSize("1.2em")} /> <Trans>Back</Trans>
            </Button>
          </a>
          <Button type="submit">
            <Trans>Register</Trans>
          </Button>
        </Row>
      </Form>
      {import.meta.env.DEV && (
        <div
          style={{
            position: "fixed",
            top: 0,
            left: 0,
            background: "white",
            color: "black",
            cursor: "pointer",
          }}
          onClick={() => {
            setFlowCheckEmail("insert@stoat.chat");
            navigate("/login/check", { replace: true });
          }}
        >
          Mock Submission
        </div>
      )}
    </>
  );
}
