package fm.backspace.bguru.chat

/** @mention helpers. Same token format as the web (src/lib/chat-mention.ts):
 *  `@name ` or `@[First Last] `. */
object Mention {
    fun token(name: String) = if (name.any(Char::isWhitespace)) "@[$name] " else "@$name "

    private fun norm(s: String) = s.lowercase().filterNot { it.isWhitespace() || it == '　' }

    /** The "@query" being typed at the end of `text` (null when not mentioning). */
    fun activeQuery(text: String): Pair<Int, String>? {
        val at = text.lastIndexOf('@')
        if (at < 0) return null
        if (at > 0 && !text[at - 1].isWhitespace()) return null
        var rest = text.substring(at + 1)
        if (rest.startsWith("[")) {
            rest = rest.substring(1)
            return if (rest.contains(']')) null else at to rest
        }
        return if (rest.any(Char::isWhitespace)) null else at to rest
    }

    fun complete(text: String, name: String): String {
        val q = activeQuery(text) ?: return text + token(name)
        return text.substring(0, q.first) + token(name)
    }

    fun candidates(members: List<MentionMember>, query: String, recent: List<String>, limit: Int = 6): List<MentionMember> {
        val q = norm(query)
        val rank = recent.withIndex().associate { it.value to it.index }
        return members
            .filter { q.isEmpty() || norm(it.name).contains(q) }
            .sortedWith(compareBy<MentionMember>({ !norm(it.name).startsWith(q) }, { rank[it.name] ?: Int.MAX_VALUE }, { it.name }))
            .take(limit)
    }
}
