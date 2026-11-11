/* global console, process, setTimeout, clearTimeout */
import { createServer, connect } from 'node:net';

const server = createServer((socket) => socket.end('ok'));
const timer = setTimeout(() => {
    console.error('TCP local: conexão não concluída em 5 segundos');
    process.exit(1);
}, 5000);
server.on('error', (error) => {
    console.error(`TCP local: ${error.message}`);
    process.exit(1);
});
server.listen(0, '127.0.0.1', () => {
    const socket = connect(server.address().port, '127.0.0.1');
    socket.on('error', (error) => {
        console.error(`TCP local: ${error.message}`);
        process.exit(1);
    });
    socket.on('data', (data) => {
        if (data.toString() !== 'ok') process.exitCode = 1;
        else console.log('TCP local: conexão e troca de dados concluídas');
        socket.end();
        server.close();
        clearTimeout(timer);
    });
});
