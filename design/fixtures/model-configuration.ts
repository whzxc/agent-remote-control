export const dispatchExample = {
  model: "GPT-5.6 Sol",
  effort: "Medium reasoning effort",
  position: { count: 3, index: 1 },
  tier: "Fast",
  fast: true,
};

export const effortGaugeForms = [
  { name: "three-levels", count: 3, index: 1 },
  { name: "four-levels", count: 4, index: 2 },
  { name: "five-levels", count: 5, index: 3 },
];

export const effortSteps = ["Inherit", "Low", "Medium", "High", "Max"];

export const modelExample = {
  title: "本任务模型",
  description: ["派发方后续发送且未指定模型时生效，", "不影响正在运行的这一轮。"],
  setting: "模型与推理强度",
  choiceLabel: "Model and effort",
  defaultLabel: "Default model",
  resetLabel: "Reset model",
  effortLabel: "Reasoning effort",
  inherit: "跟随任务",
  menuTitle: "选择模型",
};
export const followModelOptions = [{ value: "follow", label: modelExample.inherit }];
export const pickerEffortSteps = ["inherit", "low", "medium", "high", "max"];
export const modelOptions = [modelExample.inherit, "GPT-6.1 Sol", "GPT-5.6 Sol"];
export const sliderExample = { value: 0, label: "Effort" };
