import { describe, it, expect } from "vitest";
import { parseAskQuestionsAnswers } from "../src/worker.js";

// The TWX-99 readability change (de307dd) removed raw question/option IDs from the
// ask_user_questions Telegram message and now shows positional headers (Q1, Q2…)
// plus option *labels*, instructing users to "Reply with option labels. For
// multiple questions: Q1: <option label>". TWX-105 brings the inbound reply parser
// in line with that human-visible contract while keeping the old id= syntax working.

const singleQuestion = [
  {
    id: "q-priority",
    selectionMode: "single" as const,
    options: [
      { id: "opt-high", label: "High priority" },
      { id: "opt-low", label: "Low priority" },
    ],
  },
];

const multiQuestion = [
  {
    id: "q-priority",
    selectionMode: "single" as const,
    options: [
      { id: "opt-high", label: "High priority" },
      { id: "opt-low", label: "Low priority" },
    ],
  },
  {
    id: "q-tags",
    selectionMode: "multi" as const,
    options: [
      { id: "opt-bug", label: "Bug" },
      { id: "opt-feature", label: "Feature" },
      { id: "opt-chore", label: "Chore" },
    ],
  },
];

describe("parseAskQuestionsAnswers — label-based contract", () => {
  it("parses a bare option label for a single question", () => {
    expect(parseAskQuestionsAnswers("High priority", singleQuestion)).toEqual([
      { questionId: "q-priority", optionIds: ["opt-high"] },
    ]);
  });

  it("matches option labels case-insensitively and trims whitespace", () => {
    expect(parseAskQuestionsAnswers("  low PRIORITY  ", singleQuestion)).toEqual([
      { questionId: "q-priority", optionIds: ["opt-low"] },
    ]);
  });

  it("parses multi-question replies using Q<n>: addressing", () => {
    const text = "Q1: High priority\nQ2: Bug, Feature";
    expect(parseAskQuestionsAnswers(text, multiQuestion)).toEqual([
      { questionId: "q-priority", optionIds: ["opt-high"] },
      { questionId: "q-tags", optionIds: ["opt-bug", "opt-feature"] },
    ]);
  });

  it("keeps only the first option for single-select questions", () => {
    const text = "Q1: High priority, Low priority";
    expect(parseAskQuestionsAnswers(text, multiQuestion)).toEqual([
      { questionId: "q-priority", optionIds: ["opt-high"] },
    ]);
  });

  it("ignores unknown option labels", () => {
    expect(parseAskQuestionsAnswers("Nonexistent", singleQuestion)).toEqual([]);
  });

  it("does not guess for bare labels when multiple questions are pending", () => {
    // Ambiguous: no Q<n> prefix and >1 question → cannot attribute the answer.
    expect(parseAskQuestionsAnswers("High priority", multiQuestion)).toEqual([]);
  });
});

describe("parseAskQuestionsAnswers — backward compatible id syntax", () => {
  it("still accepts the legacy question_id=option_id form", () => {
    expect(parseAskQuestionsAnswers("q-priority=opt-low", singleQuestion)).toEqual([
      { questionId: "q-priority", optionIds: ["opt-low"] },
    ]);
  });

  it("accepts legacy multi-option id syntax for multi-select", () => {
    expect(parseAskQuestionsAnswers("q-tags=opt-bug,opt-chore", multiQuestion)).toEqual([
      { questionId: "q-tags", optionIds: ["opt-bug", "opt-chore"] },
    ]);
  });

  it("lets Q<n>: addressing resolve option ids too", () => {
    expect(parseAskQuestionsAnswers("Q1: opt-high", singleQuestion)).toEqual([
      { questionId: "q-priority", optionIds: ["opt-high"] },
    ]);
  });

  it("returns empty for unparseable input", () => {
    expect(parseAskQuestionsAnswers("just some chatter", multiQuestion)).toEqual([]);
  });
});
