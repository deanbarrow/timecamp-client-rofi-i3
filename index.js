#!/usr/bin/env node

const dataPath = `${process.env.HOME}/.config/timecamp`;
require("dotenv").config({ path: `${dataPath}/.env` });
const got = require("got");
const fs = require("fs");
const { exec, spawn } = require("child_process");
const orderBy = require("lodash.orderby");
const relativeDate = require("relative-date");

const timeoutTasks = process.env.TIMEOUT_TASKS || 10;
const timeoutEntries = process.env.TIMEOUT_ENTRIES || 5;

const apiKey = process.env.TIMECAMP_KEY;
if (!apiKey) {
  console.error("Set TIMECAMP_KEY in .env");
  return false;
}

const getTasks = async () => {
  let tasks;
  try {
    const response = await got(
      `https://www.timecamp.com/third_party/api/tasks/format/json/api_token/${apiKey}`
    );
    tasks = JSON.parse(response.body);
  } catch (err) {
    console.log({
      err,
    });
  }

  let tasksGrouped = {};
  for (let task in tasks) {
    const { archived, parent_id } = tasks[task];

    if (archived === 1) continue;

    if (!tasksGrouped[parent_id]) tasksGrouped[parent_id] = [];
    tasksGrouped[parent_id].push(tasks[task]);
  }

  fs.writeFileSync(
    `${dataPath}/tasks.json`,
    JSON.stringify(tasksGrouped, null, 2)
  );
};

const readTasks = async () => {
  let tasks = fs.readFileSync(`${dataPath}/tasks.json`);
  tasks = await JSON.parse(tasks);

  const activeTask = await getActiveTask();

  let entries = fs.readFileSync(`${dataPath}/entries.json`);
  entries = await JSON.parse(entries);

  const prepend = activeTask
    ? [
        `Stop Task: ${activeTask.name}`,
        `${"-".repeat(activeTask.name.length + 11)}`,
      ]
    : [];
  let output = [];
  for (let parentTask of tasks[0]) {
    const { task_id, name } = parentTask;
    for (let task of tasks[task_id]) {
      task.last = "0";
      entries.forEach((e) => {
        if (task.task_id.toString() === e.task_id)
          if (e.last_modify > task.last) task.last = e.last_modify;
      });
      output.push({
        name: `${name}: ${task.name}`,
        last: task.last,
      });
    }
  }

  output = orderBy(output, ["last", "name"], ["desc", "asc"]);
  output = output.map((o) => o.name);

  return {
    tasks,
    list: [...prepend, ...output],
  };
};

const getActiveTask = async () => {
  try {
    let active = fs.readFileSync(`${dataPath}/active.json`);
    active = await JSON.parse(active);
    active.duration = active
      ? parseInt(
          (new Date() - new Date(active.started_at.replace(/-/g, "/"))) / 1000
        )
      : 0;
    return active ? active : false;
  } catch (err) {
    // console.log({err})
    return false;
  }
};

const displayMenu = async () => {
  const { tasks, list } = await readTasks();

  const activeTask = await getActiveTask();

  let status = fs.readFileSync(`${dataPath}/status.json`);
  status = await JSON.parse(status);

  let mesg = `Today: ${status.today.hours}:${status.today.minutes}, this week: ${status.week.hours}:${status.week.minutes}.`;
  if (activeTask)
    mesg += `\nYou started working on ${activeTask.name} ${relativeDate(
      new Date(activeTask.started_at.replace(/-/g, "/"))
    )}.`;

  const child = spawn("rofi", ["-dmenu", "-i", "-p", "Task", "-mesg", mesg]);
  child.stdin.write(list.join("\n"));
  child.stdin.end();

  let selected;
  for await (const data of child.stdout) {
    selected = data.toString().replace("\n", "");
  }
  if (!selected) return false;

  if (selected && selected.substring(0, 10) === "Stop Task:")
    await stopCurrentTask();

  let match = false;
  for (let parentTask of tasks[0]) {
    const { task_id, name } = parentTask;

    for (let task of tasks[task_id]) {
      if (`${name}: ${task.name}` === selected) {
        selected = task;
        match = true;
      }
    }
  }
  if (!match) return false;

  await startTask(selected);
};

const startTask = async (task) => {
  let activeTask = await getActiveTask();
  if (activeTask) await stopCurrentTask();

  const { task_id, name } = task;
  const started_at = timeNow();

  try {
    const response = await got.post(
      `https://www.timecamp.com/third_party/api/timer/format/json/api_token/${apiKey}`,
      {
        json: {
          action: "start",
          task_id,
          started_at,
        },
        responseType: "json",
      }
    );

    activeTask = response.body;
  } catch (err) {
    console.log({
      err,
    });
  }

  activeTask = {
    ...activeTask,
    name,
    started_at: formatedTimestamp(),
  };
  fs.writeFileSync(
    `${dataPath}/active.json`,
    JSON.stringify(activeTask, null, 2)
  );

  await exec(
    `notify-send -i ${__dirname}/img/timecamp.png 'Task Started' '${name}'`
  );
};

const stopCurrentTask = async () => {
  const activeTask = await getActiveTask();
  if (!activeTask) return false;

  const { new_timer_id, name } = activeTask;
  const stopped_at = timeNow();

  try {
    await got.post(
      `https://www.timecamp.com/third_party/api/timer/format/json/api_token/${apiKey}`,
      {
        json: {
          action: "stop",
          timer_id: new_timer_id,
          stopped_at,
        },
        responseType: "json",
      }
    );
  } catch (err) {
    console.log({
      err,
    });
  }

  fs.unlinkSync(`${dataPath}/active.json`);
  await exec(
    `notify-send -i ${__dirname}/img/timecamp.png 'Task Stopped' '${name}'`
  );
};

const timeNow = () =>
  new Date().toLocaleString().replace(/\//g, "-").replace(",", "");

// https://gist.github.com/MythRen/c4921735812dd2c0217a#gistcomment-3325758
const formatedTimestamp = () => {
  const d = new Date();
  const date = d.toISOString().split("T")[0];
  const time = d.toTimeString().split(" ")[0];
  return `${date} ${time}`;
};

const getEntries = async () => {
  // Start from Monday as current work week
  const curr = new Date();
  const first = curr.getDay() === 0 ? 6 : curr.getDay() - 1;
  const last = 6 - first;

  const rangeStart = new Date(new Date().setDate(new Date().getDate() - first))
    .toISOString()
    .substring(0, 10);
  const rangeEnd = new Date(new Date().setDate(new Date().getDate() + last))
    .toISOString()
    .substring(0, 10);
  const now = new Date();

  let entries;
  try {
    const response = await got(
      `https://www.timecamp.com/third_party/api/entries/format/json/api_token/${apiKey}/from/${rangeStart}/to/${rangeEnd}`
    );
    entries = JSON.parse(response.body);
  } catch (err) {
    console.log({
      err,
    });
    return false;
  }

  const activeTask = await getActiveTask();
  let today = activeTask.duration || 0,
    week = today;
  for (let entry of entries) {
    const { date, duration } = entry;
    if (date === now.toISOString().substring(0, 10))
      today += parseInt(duration);
    week += parseInt(duration);
  }

  const output = {
    today: {
      hours: Math.floor(today / 3600)
        .toString()
        .padStart(2, "0"),
      minutes: Math.floor((today % 3600) / 60)
        .toString()
        .padStart(2, "0"),
    },
    week: {
      hours: Math.floor(week / 3600)
        .toString()
        .padStart(2, "0"),
      minutes: Math.floor((week % 3600) / 60)
        .toString()
        .padStart(2, "0"),
    },
  };

  fs.writeFileSync(
    `${dataPath}/entries.json`,
    JSON.stringify(entries, null, 2)
  );
  fs.writeFileSync(`${dataPath}/status.json`, JSON.stringify(output, null, 2));
};

const geti3Block = async () => {
  let status = fs.readFileSync(`${dataPath}/status.json`);
  status = await JSON.parse(status);
  const logged = `Today ${status.today.hours}:${status.today.minutes}, Week ${status.week.hours}:${status.week.minutes}`;

  const activeTask = await getActiveTask();
  let taskShort = "",
    taskLong;
  if (activeTask) {
    taskShort = `${activeTask.name} `;
    taskLong = `Task: ${activeTask.name} `;
  } else {
    taskLong = "No Active Task ";
  }

  // Long
  console.log(`${taskLong} ${logged}`);

  // Short
  console.log(`${taskShort} ${logged}`);
};

const auto = async () => {
  await getEntries();
  setInterval(getEntries, timeoutEntries * 1000 * 60);

  await getTasks();
  setInterval(getTasks, timeoutTasks * 1000 * 60);
};

(async () => {
  const input = process.argv[2];
  switch (input) {
    case "tasks":
      await getTasks();
      break;
    case "entries":
      await getEntries();
      break;
    case "menu":
      await displayMenu();
      break;
    case "i3block":
      await geti3Block();
      break;
    case "auto":
      await auto();
      break;
    default:
      console.log(
        "A rofi based client for Timecamp with i3blocks support.\nInput: node index.js tasks | entries | menu | i3block | auto"
      );
      break;
  }
})();
