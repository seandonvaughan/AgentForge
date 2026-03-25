/**
 * Interactive Terminal Interview Runner for AgentForge Genesis.
 *
 * Conducts a live, interactive interview with the user using Node.js
 * readline/promises for terminal I/O. Evaluates conditional questions
 * and displays a step counter as the interview progresses.
 */

import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import type { InterviewQuestion } from "./interviewer.js";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run an interactive interview session with the user.
 *
 * Displays questions sequentially, respecting conditional logic, and
 * collects answers from the user's terminal input. Returns all answers
 * keyed by question ID.
 *
 * @param questions - Array of {@link InterviewQuestion} to ask.
 * @returns A record mapping question IDs to user answers.
 */
export async function runInteractiveInterview(
  questions: InterviewQuestion[],
): Promise<Record<string, string>> {
  const rl = createInterface({ input, output });
  const answers: Record<string, string> = {};

  try {
    // Count total non-skipped questions to display accurate step counter
    let totalSteps = 0;
    for (const q of questions) {
      if (!q.condition || q.condition(answers)) {
        totalSteps++;
      }
    }

    let currentStep = 0;

    for (const question of questions) {
      // Evaluate condition — skip if returns false
      if (question.condition && !question.condition(answers)) {
        continue;
      }

      currentStep++;

      // Display step counter
      console.log(`\n── Step ${currentStep} of ${totalSteps} ──`);

      // Display question text
      console.log(`\n  ${question.question}`);

      let answer = "";

      switch (question.type) {
        case "text": {
          // Text input — read a line with "> " prompt
          answer = await rl.question("  > ");
          break;
        }

        case "choice": {
          // Choice input — display numbered options, read a number
          const choices = question.choices ?? [];
          for (let i = 0; i < choices.length; i++) {
            console.log(`    ${i + 1}. ${choices[i]}`);
          }

          let validChoice = false;
          while (!validChoice) {
            const input = await rl.question("  > ");
            const choiceIndex = parseInt(input, 10) - 1;

            if (
              Number.isInteger(choiceIndex) &&
              choiceIndex >= 0 &&
              choiceIndex < choices.length
            ) {
              answer = choices[choiceIndex];
              validChoice = true;
            } else {
              console.log(
                `    Invalid choice. Please enter a number between 1 and ${choices.length}.`,
              );
            }
          }
          break;
        }

        case "confirm": {
          // Confirm input — accept y/yes → "yes", anything else → "no"
          const input = await rl.question("  > ");
          const normalized = input.toLowerCase().trim();
          answer = normalized === "y" || normalized === "yes" ? "yes" : "no";
          break;
        }

        default: {
          // Should not reach here given TypeScript, but be defensive
          answer = "";
        }
      }

      // Store the answer
      answers[question.id] = answer;
    }

    return answers;
  } finally {
    // Always close the readline interface
    rl.close();
  }
}
