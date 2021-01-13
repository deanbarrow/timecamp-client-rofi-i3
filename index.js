#!/usr/bin/env node

const dataPath = `${process.env.HOME}/.config/timecamp`;
require('dotenv').config({ path: `${dataPath}/.env` });
const got = require('got');
const fs = require('fs');
const {
    exec,
    spawn
} = require('child_process')

const timeoutTasks = process.env.TIMEOUT_TASKS || 10
const timeoutEntries = process.env.TIMEOUT_ENTRIES || 5

const apiKey = process.env.TIMECAMP_KEY
if (!apiKey) {
    console.error('Set TIMECAMP_KEY in .env')
    return false
}

const getTasks = async () => {

    let tasks
    try {
        const response = await got(`https://www.timecamp.com/third_party/api/tasks/format/json/api_token/${apiKey}`)
        tasks = JSON.parse(response.body)
    } catch (err) {
        console.log({
            err
        })
    }

    let tasksGrouped = {}
    for (let task in tasks) {
        const {
            archived,
            parent_id
        } = tasks[task]

        if (archived !== '0') continue

        if (!tasksGrouped[parent_id]) tasksGrouped[parent_id] = []
        tasksGrouped[parent_id].push(tasks[task])

    }

    fs.writeFileSync(`${dataPath}/tasks.json`, JSON.stringify(tasksGrouped, null, 2))
}

const readTasks = async () => {

    let tasks = fs.readFileSync(`${dataPath}/tasks.json`)
    tasks = await JSON.parse(tasks)

    const activeTask = await getActiveTask()


    const prepend = activeTask ? [`Stop Task: ${activeTask.name}`, `${'-'.repeat(activeTask.name.length + 11)}`] : []
    const output = []
    for (let parentTask of tasks[0]) {
        const {
            task_id,
            name
        } = parentTask
        for (let task of tasks[task_id]) {
            output.push(`${name}: ${task.name}`)
        }
    }
    return {
        tasks,
        list: [...prepend, ...output.sort()]
    }
}

const getActiveTask = async () => {
    try {
        let active = fs.readFileSync(`${dataPath}/active.json`)
        active = await JSON.parse(active)
        return active ? active : false
    } catch (err) {
        return false
    }
}

const displayMenu = async () => {

    const {
        tasks,
        list
    } = await readTasks()

    const child = spawn('rofi', ['-dmenu', '-i', '-p', 'Select Task', '-location', '1', '-width', '100', '-lines', '15', '-line-margin', '0', '-line-padding', '1', '-separator-style', 'none', '-font', 'mono 10', '-columns', '8', '-bw', '0', '-disable-history', '-hidde-scrollbar'])
    child.stdin.write(list.join('\n'))
    child.stdin.end();

    let selected
    for await (const data of child.stdout) {
        selected = data.toString().replace('\n', '')
    };
    if (!selected) return false

    if (selected && selected.substring(0, 10) === 'Stop Task:')
        await stopCurrentTask()

    let match = false
    for (let parentTask of tasks[0]) {
        const {
            task_id,
            name
        } = parentTask

        for (let task of tasks[task_id]) {
            if (`${name}: ${task.name}` === selected) {
                selected = task
                match = true
            }
        }
    }
    if (!match) return false

    await startTask(selected)

}

const startTask = async (task) => {
    let activeTask = await getActiveTask()
    if (activeTask) await stopCurrentTask()

    const {
        task_id,
        name
    } = task
    const started_at = timeNow()

    try {
        const response = await got.post(`https://www.timecamp.com/third_party/api/timer/format/json/api_token/${apiKey}`, {
            json: {
                action: 'start',
                task_id,
                started_at
            },
            responseType: 'json'
        })

        activeTask = response.body
    } catch (err) {
        console.log({
            err
        })
    }

    activeTask = {
        ...activeTask,
        name
    }
    fs.writeFileSync(`${dataPath}/active.json`, JSON.stringify(activeTask, null, 2))

    await exec(`notify-send -i ${dataPath}/timecamp.png 'Task Started' '${name}'`)
}

const stopCurrentTask = async () => {

    const activeTask = await getActiveTask()
    if (!activeTask) return false

    const {
        new_timer_id,
        name
    } = activeTask
    const stopped_at = timeNow()

    try {
        const response = await got.post(`https://www.timecamp.com/third_party/api/timer/format/json/api_token/${apiKey}`, {
            json: {
                action: 'stop',
                timer_id: new_timer_id,
                stopped_at
            },
            responseType: 'json'
        })
    } catch (err) {
        console.log({
            err
        })
    }

    fs.unlinkSync(`${dataPath}/active.json`)
    await exec(`notify-send -i ${dataPath}/timecamp.png 'Task Stopped' '${name}'`)
}

const timeNow = () => new Date().toLocaleString().replace(/\//g, '-').replace(',', '')

const getEntries = async () => {

    // Start from Monday as current work week
    // https://stackoverflow.com/questions/5210376/how-to-get-first-and-last-day-of-the-week-in-javascript/44392420
    const curr = new Date;
    const first = curr.getDate() - curr.getDay() + 1;
    const last = first + 6;
    const rangeStart = new Date(curr.setDate(first)).toISOString().substring(0, 10)
    const rangeEnd = new Date(curr.setDate(last)).toISOString().substring(0, 10)
    const now = new Date

    let entries
    try {
        const response = await got(`https://www.timecamp.com/third_party/api/entries/format/json/api_token/${apiKey}/from/${rangeStart}/to/${rangeEnd}`)
        entries = JSON.parse(response.body)
    } catch (err) {
        console.log({
            err
        })
        return false
    }

    let today = 0,
        week = 0
    for (let entry of entries) {
        const {
            date,
            duration
        } = entry
        if (date === now.toISOString().substring(0, 10))
            today += parseInt(duration)
        week += parseInt(duration)
    }

    const output = {
        today: {
            hours: Math.floor(today / 3600).toString().padStart(2, '0'),
            minutes: Math.floor(today % 3600 / 60).toString().padStart(2, '0')
        },
        week: {
            hours: Math.floor(week / 3600).toString().padStart(2, '0'),
            minutes: Math.floor(week % 3600 / 60).toString().padStart(2, '0')
        }
    }

    fs.writeFileSync(`${dataPath}/status.json`, JSON.stringify(output, null, 2))
}


const geti3Block = async () => {

    let status = fs.readFileSync(`${dataPath}/status.json`)
    status = await JSON.parse(status)
    const logged = `Today ${status.today.hours}:${status.today.minutes}, Week ${status.week.hours}:${status.week.minutes}`

    const activeTask = await getActiveTask()
    let taskShort = '',
        taskLong
    if (activeTask) {
        taskShort = `${activeTask.name} `
        taskLong = `Task: ${activeTask.name} `
    } else {
        taskLong = 'No Active Task '
    }

    // Long
    console.log(`${taskLong} ${logged}`)

    // Short
    console.log(`${taskShort} ${logged}`)
}


const auto = async () => {
    await getTasks();
    setInterval(getTasks, timeoutTasks * 1000 * 60);

    await getEntries();
    setInterval(getEntries, timeoutEntries * 1000 * 60);
}

;
(async () => {

    const input = process.argv[2]
    switch (input) {
        case 'tasks':
            await getTasks();
            break;
        case 'entries':
            await getEntries();
            break;
        case 'menu':
            await displayMenu();
            break;
        case 'i3block':
            await geti3Block();
            break;
        case 'auto':
            await auto();
            break;
        default:
            console.log('A rofi based client for Timecamp with i3blocks support.\nInput: node index.js tasks | entries | menu | i3block | auto');
            break;
    }
})()