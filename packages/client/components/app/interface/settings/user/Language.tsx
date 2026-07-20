import { Show } from "solid-js";

import { Trans, useLingui } from "@lingui-solid/solid/macro";

import { TRANSLATE_LANGUAGES } from "@revolt/common";
import { Language, Languages, browserPreferredLanguage } from "@revolt/i18n";
import type { LanguageEntry } from "@revolt/i18n/Languages";
import { timeLocale } from "@revolt/i18n/dayjs";
import { UnicodeEmoji } from "@revolt/markdown/emoji";
import { captionBroadcastSupported, captionSttEngineKind } from "@revolt/rtc";
import { useState } from "@revolt/state";
import {
  CategoryButton,
  CategorySelectOption,
  Checkbox,
  Column,
  Row,
  Time,
  iconSize,
} from "@revolt/ui";

import MdErrorFill from "@material-design-icons/svg/filled/error.svg?component-solid";
import MdVerifiedFill from "@material-design-icons/svg/filled/verified.svg?component-solid";
import MdCalendarMonth from "@material-design-icons/svg/outlined/calendar_month.svg?component-solid";
import MdLanguage from "@material-design-icons/svg/outlined/language.svg?component-solid";
import MdMic from "@material-design-icons/svg/outlined/mic.svg?component-solid";
import MdRecordVoiceOver from "@material-design-icons/svg/outlined/record_voice_over.svg?component-solid";
import MdSchedule from "@material-design-icons/svg/outlined/schedule.svg?component-solid";
import MdTranslate from "@material-design-icons/svg/outlined/translate.svg?component-solid";
import MdVolumeUp from "@material-design-icons/svg/outlined/volume_up.svg?component-solid";

/**
 * Language
 */
export function LanguageSettings() {
  return (
    <Column gap="lg">
      <CategoryButton.Group>
        <PickLanguage />
        {/* <ConfigureRTL /> */}
      </CategoryButton.Group>
      <CategoryButton.Group>
        <PickDateFormat />
        <PickTimeFormat />
      </CategoryButton.Group>
      <CategoryButton.Group>
        <ToggleMessageTranslation />
        <PickTranslationLanguage />
      </CategoryButton.Group>
      <CategoryButton.Group>
        <ToggleCallCaptions />
        <PickCaptionLanguage />
        <PickSpokenLanguage />
        <ToggleSpeakCaptions />
      </CategoryButton.Group>
    </Column>
  );
}

const RE_LANG = /_/g;

/**
 * Pick user's preferred language
 */
function PickLanguage() {
  const { locale } = useState();
  const { i18n } = useLingui();

  //@ts-expect-error unfilled object
  const langOpts: { [k in Language]: CategorySelectOption } = {};
  const langIds = Object.keys(Languages) as Language[];

  //Move user's system language to top
  //TODO: Make browserPreferredLanguage() reactive, then make langOpts a memo
  const prefLang = browserPreferredLanguage();
  if (prefLang) {
    const prefIdx = langIds.findIndex(
      (id) => id.replace(RE_LANG, "-") === prefLang,
    );
    if (prefIdx !== -1) langIds.unshift(langIds.splice(prefIdx, 1)[0]);
  }

  //Generate language dict
  let id: Language, lang: LanguageEntry;
  for (id of langIds) {
    lang = Languages[id];
    langOpts[id] = {
      title: (
        <Row>
          {lang.display}{" "}
          {lang.verified && (
            <MdVerifiedFill
              {...iconSize(18)}
              fill="var(--md-sys-color-on-surface)"
            />
          )}{" "}
          {lang.incomplete && (
            <MdErrorFill
              {...iconSize(18)}
              fill="var(--md-sys-color-on-surface)"
            />
          )}
        </Row>
      ),
      shortDesc: lang.display,
      icon: <UnicodeEmoji emoji={lang.emoji} />,
    };
  }

  return (
    <CategoryButton.Select
      icon={<MdLanguage {...iconSize(22)} />}
      title={<Trans>Select your language</Trans>}
      value={i18n().locale as Language}
      options={langOpts}
      onUpdate={(id) => locale.switch(id)}
    />
  );
}

/**
 * Toggle automatic translation of other people's messages
 */
function ToggleMessageTranslation() {
  const state = useState();

  return (
    <CategoryButton
      icon={<MdTranslate {...iconSize(22)} />}
      description={
        <Trans>
          Automatically detect and translate messages sent by other people.
          Message text is sent to Google Translate; encrypted messages are never
          translated.
        </Trans>
      }
      action={
        <Checkbox
          checked={state.settings.getValue("translation:enabled") ?? false}
          onChange={(event) =>
            state.settings.setValue(
              "translation:enabled",
              event.currentTarget.checked,
            )
          }
        />
      }
      onClick={() =>
        state.settings.setValue(
          "translation:enabled",
          !state.settings.getValue("translation:enabled"),
        )
      }
    >
      <Trans>Translate messages</Trans>
    </CategoryButton>
  );
}

/**
 * Pick the target language for automatic message translation
 */
function PickTranslationLanguage() {
  const state = useState();

  const options: Record<string, CategorySelectOption> = {};
  for (const [code, name] of TRANSLATE_LANGUAGES) {
    options[code] = {
      title: name,
      shortDesc: name,
    };
  }

  return (
    <CategoryButton.Select
      icon={<MdLanguage {...iconSize(22)} />}
      title={<Trans>Translate messages to</Trans>}
      value={(state.settings.getValue("translation:target") as string) ?? "en"}
      options={options}
      onUpdate={(code) =>
        state.settings.setValue("translation:target", code as string)
      }
    />
  );
}

/**
 * Toggle translated live captions during voice/video calls
 */
function ToggleCallCaptions() {
  const state = useState();

  return (
    <CategoryButton
      icon={<MdRecordVoiceOver {...iconSize(22)} />}
      description={
        <>
          <Show
            when={captionSttEngineKind() === "android"}
            fallback={
              <Trans>
                Show live captions during voice and video calls, translated into
                your chosen language. Your microphone audio is sent to your
                browser's speech service (Google) to transcribe it, and the text
                is sent to Google Translate; captions are disabled on end-to-end
                encrypted calls.
              </Trans>
            }
          >
            <Trans>
              Show live captions during voice and video calls, translated into
              your chosen language. Your speech is transcribed on your device,
              and the text is sent to Google Translate; captions are disabled on
              end-to-end encrypted calls.
            </Trans>
          </Show>
          <Show when={!captionBroadcastSupported()}>
            {" "}
            <Trans>
              Broadcasting your own captions isn't supported in this app or
              browser — you'll still see other people's captions.
            </Trans>
          </Show>
        </>
      }
      action={
        <Checkbox
          checked={state.settings.getValue("captions:enabled") ?? false}
          onChange={(event) =>
            state.settings.setValue(
              "captions:enabled",
              event.currentTarget.checked,
            )
          }
        />
      }
      onClick={() =>
        state.settings.setValue(
          "captions:enabled",
          !state.settings.getValue("captions:enabled"),
        )
      }
    >
      <Trans>Live call captions</Trans>
    </CategoryButton>
  );
}

/**
 * Pick the language call captions are translated into
 */
function PickCaptionLanguage() {
  const state = useState();

  const options: Record<string, CategorySelectOption> = {};
  for (const [code, name] of TRANSLATE_LANGUAGES) {
    options[code] = {
      title: name,
      shortDesc: name,
    };
  }

  return (
    <CategoryButton.Select
      icon={<MdLanguage {...iconSize(22)} />}
      title={<Trans>Translate captions to</Trans>}
      value={(state.settings.getValue("captions:target") as string) ?? "en"}
      options={options}
      onUpdate={(code) =>
        state.settings.setValue("captions:target", code as string)
      }
    />
  );
}

/**
 * Pick the language I speak, used to transcribe my outgoing captions
 */
function PickSpokenLanguage() {
  const state = useState();
  const { t } = useLingui();

  const options: Record<string, CategorySelectOption> = {
    "": {
      title: t`Automatic`,
      shortDesc: t`Automatic`,
    },
  };
  for (const [code, name] of TRANSLATE_LANGUAGES) {
    options[code] = {
      title: name,
      shortDesc: name,
    };
  }

  return (
    <CategoryButton.Select
      icon={<MdMic {...iconSize(22)} />}
      title={<Trans>My spoken language</Trans>}
      value={(state.settings.getValue("captions:spoken") as string) ?? ""}
      options={options}
      onUpdate={(code) =>
        state.settings.setValue("captions:spoken", code as string)
      }
    />
  );
}

/**
 * Toggle reading translated call captions aloud (on-device TTS)
 */
function ToggleSpeakCaptions() {
  const state = useState();

  return (
    <CategoryButton
      icon={<MdVolumeUp {...iconSize(22)} />}
      description={
        <Trans>
          Also read translated captions aloud using your device's voice. Runs on
          the receiving side and never reads your own captions back to you.
        </Trans>
      }
      action={
        <Checkbox
          checked={state.settings.getValue("captions:speak") ?? false}
          onChange={(event) =>
            state.settings.setValue(
              "captions:speak",
              event.currentTarget.checked,
            )
          }
        />
      }
      onClick={() =>
        state.settings.setValue(
          "captions:speak",
          !state.settings.getValue("captions:speak"),
        )
      }
    >
      <Trans>Speak captions aloud</Trans>
    </CategoryButton>
  );
}

/**
 * Pick user's preferred date format
 */
function PickDateFormat() {
  const { locale } = useState();
  const LastWeek = new Date();
  LastWeek.setDate(LastWeek.getDate() - 7);

  return (
    <CategoryButton.Select
      icon={<MdCalendarMonth {...iconSize(22)} />}
      title={<Trans>Date format</Trans>}
      value={timeLocale()[1].formats.L}
      options={{
        "DD/MM/YYYY": {
          shortDesc: <Trans>Traditional (DD/MM/YYYY)</Trans>,
          description: <Time format="date" value={LastWeek} />,
        },
        "MM/DD/YYYY": {
          shortDesc: <Trans>American (MM/DD/YYYY)</Trans>,
          description: <Time format="dateAmerican" value={LastWeek} />,
        },
        "YYYY-MM-DD": {
          shortDesc: <Trans>ISO Standard (YYYY-MM-DD)</Trans>,
          description: <Time format="iso8601" value={LastWeek} />,
        },
      }}
      onUpdate={(f) => locale.setDateFormat(f)}
    />
  );
}

/**
 * Pick user's preferred time format
 */
function PickTimeFormat() {
  const { locale } = useState();

  return (
    <CategoryButton.Select
      icon={<MdSchedule {...iconSize(22)} />}
      title={<Trans>Time format</Trans>}
      value={timeLocale()[1].formats.LT}
      options={{
        "HH:mm": {
          shortDesc: <Trans>24 hours</Trans>,
          description: <Time format="time24" value={new Date()} />,
        },
        "h:mm A": {
          shortDesc: <Trans>12 hours</Trans>,
          description: <Time format="time12" value={new Date()} />,
        },
      }}
      onUpdate={(f) => locale.setTimeFormat(f)}
    />
  );
}

// /**
//  * Configure right-to-left display
//  */
// function ConfigureRTL() {
//   /**
//    * Determine the current language
//    */
//   const currentLanguage = () => Languages[language()];

//   return (
//     <Switch
//       fallback={
//         <CategoryButton
//           icon={<MdKeyboardTabRtl {...iconSize(22)} />}
//           description={<Trans>Flip the user interface right to left</Trans>}
//           action={<Checkbox />}
//           onClick={() => void 0}
//         >
//           <Trans>Enable RTL layout</Trans>
//         </CategoryButton>
//       }
//     >
//       <Match when={currentLanguage().rtl}>
//         <CategoryButton
//           icon={<MdKeyboardTab {...iconSize(22)} />}
//           description={<Trans>Keep the user interface left to right</Trans>}
//           action={<Checkbox />}
//           onClick={() => void 0}
//         >
//           <Trans>Force LTR layout</Trans>
//         </CategoryButton>
//       </Match>
//     </Switch>
//   );
// }

