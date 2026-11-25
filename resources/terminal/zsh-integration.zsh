# Private controller transport; source only after the user's startup files.
[[ -o interactive && -n $PI_DESKTOP_TERMINAL_SOCKET && ${#PI_DESKTOP_TERMINAL_TOKEN} -ge 32 && ${#PI_DESKTOP_TERMINAL_TOKEN} -le 64 && $PI_DESKTOP_TERMINAL_TOKEN != *[^0-9a-fA-F]* && ${#PI_DESKTOP_TERMINAL_DISPATCH} == 17 && ${PI_DESKTOP_TERMINAL_DISPATCH[1,7]} == $'\e[6973;' && ${PI_DESKTOP_TERMINAL_DISPATCH[8,16]} != *[^0-9]* && ${PI_DESKTOP_TERMINAL_DISPATCH[17]} == '~' ]] || { print -u2 -- 'Terminal integration: invalid socket, token, or dispatch key.'; return 1; }
zmodload zsh/net/socket zsh/system zsh/datetime || return 1
zsocket "$PI_DESKTOP_TERMINAL_SOCKET" || return 1
typeset -gi _terminal_proof_fd_number=$REPLY
print -r -u $_terminal_proof_fd_number -- "0;hello;1;$PI_DESKTOP_TERMINAL_TOKEN;$$" || return 1
unset PI_DESKTOP_TERMINAL_TOKEN
autoload -Uz add-zsh-hook add-zle-hook-widget
if (( ! $+functions[_main_complete] )); then
  autoload -Uz compinit
  compinit -i -D || return 1
fi
typeset -g _terminal_proof_prompt=$PROMPT _terminal_proof_rprompt=$RPROMPT
typeset -g _terminal_proof_pending='' _terminal_proof_mode=fixed _terminal_proof_discard=0
typeset -ga _terminal_proof_options _terminal_proof_positions
typeset -gi _terminal_proof_matches=0 _terminal_proof_index=0 _terminal_proof_generation=0 _terminal_proof_list_valid=0
typeset -g _terminal_proof_loaded=''
typeset -g _terminal_proof_shelf_prompt='%B%F{blue}❯%f '
typeset -gF _terminal_proof_started=0
# Presentation is emitted by the shell on the PTY, never inferred from socket timing.
_terminal_proof_complete() {
  local MENUSELECT
  _main_complete
  _terminal_proof_matches=${compstate[nmatches]:-0}
  unset MENUSELECT
  compstate[list]='' compstate[insert]=unambiguous
}
_terminal_proof_pick() {
  _terminal_proof_list_valid=0
  [[ -n ${compstate[old_list]} ]] && _terminal_proof_list_valid=1
  compstate[old_list]=keep compstate[old_insert]='' compstate[list]=''
  compstate[insert]="$_terminal_proof_index "
}
zle -C _terminal_proof_complete complete-word _terminal_proof_complete
zle -C _terminal_proof_pick complete-word _terminal_proof_pick
PROMPT='' RPROMPT=''
_terminal_proof_emit() { print -r -u $_terminal_proof_fd_number -- "$1" || _terminal_proof_disconnect }
_terminal_proof_hex() { REPLY=$(print -rn -- "$1" | od -v -An -tx1 | tr -d ' \n'); }
_terminal_proof_duration() {
  local -F elapsed=$1
  (( elapsed < 0 )) && elapsed=0
  if (( elapsed < 60 )); then
    printf -v REPLY '%.2f s' $elapsed
    return
  fi
  # Long durations retain every completed second, not rounded minutes or hours.
  local -i seconds=$(( elapsed ))
  if (( seconds >= 86400 )); then
    printf -v REPLY '%d d %02d h %02d m %02d s' $(( seconds / 86400 )) $(( seconds % 86400 / 3600 )) $(( seconds % 3600 / 60 )) $(( seconds % 60 ))
  elif (( seconds >= 3600 )); then
    printf -v REPLY '%d h %02d m %02d s' $(( seconds / 3600 )) $(( seconds % 3600 / 60 )) $(( seconds % 60 ))
  else
    printf -v REPLY '%d m %02d s' $(( seconds / 60 )) $(( seconds % 60 ))
  fi
}
_terminal_proof_precmd() {
  local -i command_status=$?
  local -F elapsed
  local duration rule label
  local -i width
  if (( _terminal_proof_started > 0 )); then
    elapsed=$(( EPOCHREALTIME - _terminal_proof_started ))
    _terminal_proof_started=0
    _terminal_proof_duration "$elapsed"
    duration=$REPLY
    if (( command_status == 0 )); then label="Completed · $duration"; else label="Exit $command_status · $duration"; fi
    width=$(( COLUMNS - ${#label} - 4 ))
    (( width < 3 )) && width=3
    # Keep the rule compact so normal wide-to-narrow window reflow does not
    # turn an old completion divider into multiple rows.
    (( width > 24 )) && width=24
    printf -v rule '%*s' $width ''
    rule=${rule// /─}
    printf '\n\e[0;2m%s  %s\e[0m\n\n' "$label" "$rule"
  fi
  [[ -n $PROMPT && $PROMPT != $_terminal_proof_shelf_prompt ]] && _terminal_proof_prompt=$PROMPT
  [[ -n $RPROMPT ]] && _terminal_proof_rprompt=$RPROMPT
  if (( _terminal_proof_fd_number >= 0 )); then _terminal_proof_mode=fixed; PROMPT='' RPROMPT=''; fi
  return 0
}
_terminal_proof_running() {
  if (( _terminal_proof_fd_number >= 0 )); then
    [[ $PROMPT == $_terminal_proof_shelf_prompt ]] && printf '\e[0m'
    _terminal_proof_started=$EPOCHREALTIME
    _terminal_proof_emit "0;running;$_terminal_proof_generation"
  fi
  return 0
}
_terminal_proof_init() {
  if (( _terminal_proof_fd_number < 0 )); then _terminal_proof_mode=direct; return; fi
  if (( _terminal_proof_generation >= 1000000000 )); then _terminal_proof_disconnect; return; fi
  (( ++_terminal_proof_generation ))
  _terminal_proof_loaded=''
  if [[ $PROMPT == $_terminal_proof_shelf_prompt ]]; then PROMPT=''; fi
  if [[ $CONTEXT == start ]] && (( _terminal_proof_fd_number >= 0 )); then _terminal_proof_mode=fixed; else _terminal_proof_mode=direct; fi
  if (( _terminal_proof_fd_number >= 0 )); then
    _terminal_proof_hex "$PWD"
    _terminal_proof_emit "0;init;$CONTEXT;$_terminal_proof_mode;$_terminal_proof_generation;$REPLY"
  fi
}
_terminal_proof_finish() { (( _terminal_proof_fd_number >= 0 )) && _terminal_proof_emit "0;finish;$CONTEXT;$_terminal_proof_generation" }
_terminal_proof_disconnect() {
  (( _terminal_proof_fd_number >= 0 )) || return
  local -i clear_buffer=0
  [[ $_terminal_proof_mode == fixed ]] && clear_buffer=1
  exec {_terminal_proof_fd_number}>&-
  _terminal_proof_fd_number=-1 _terminal_proof_loaded='' _terminal_proof_mode=direct
  PROMPT=$_terminal_proof_prompt RPROMPT=$_terminal_proof_rprompt
  if zle; then
    (( clear_buffer )) && { BUFFER='' CURSOR=0; }
    zle reset-prompt
    zle -M 'Terminal integration disconnected; direct mode restored.'
  fi
}
add-zsh-hook precmd _terminal_proof_precmd
add-zsh-hook preexec _terminal_proof_running
add-zle-hook-widget line-init _terminal_proof_init
add-zle-hook-widget line-finish _terminal_proof_finish

_terminal_proof_process() {
  local frame=$1 id action cursor hex decoded='' pair result failure='' saved_redraw=0
  local -i i n position limit
  if [[ $frame != <->:*:<->:<->:* ]]; then _terminal_proof_emit '0;error;invalid-frame'; return; fi
  id=${frame%%:*}; frame=${frame#*:}
  action=${frame%%:*}; frame=${frame#*:}
  cursor=${frame%%:*}; frame=${frame#*:}
  n=${frame%%:*}; hex=${frame#*:}
  (( ${#id} <= 10 )) && (( 10#$id >= 1 && 10#$id <= 1000000000 )) || { _terminal_proof_emit '0;error;invalid-frame'; return; }
  if [[ $action != [csdgkx] ]] || (( ${#cursor}>5 || ${#n}>10 || ${#hex}>8192 || ${#hex}%2 )) || [[ $hex == *[^0-9a-fA-F]* ]]; then _terminal_proof_emit "$id;error;invalid-frame"; return; fi
  cursor=$((10#$cursor)) n=$((10#$n))
  (( n <= 1000000000 )) || { _terminal_proof_emit "$id;error;invalid-frame"; return; }
  (( n >= 1 && n == _terminal_proof_generation )) || { _terminal_proof_emit "$id;error;stale-generation"; return; }
  for (( i=1; i<=${#hex}; i+=2 )); do
    pair=${hex[i,i+1]}; [[ $pair == 00 ]] && { _terminal_proof_emit "$id;error;invalid-buffer"; return; }
    decoded+="\\x$pair"
  done
  printf -v decoded '%b' "$decoded"
  print -rn -- "$decoded" | iconv -f UTF-8 -t UTF-8 >/dev/null 2>&1 || { _terminal_proof_emit "$id;error;invalid-buffer"; return; }
  (( cursor <= ${#decoded} )) || { _terminal_proof_emit "$id;error;invalid-buffer"; return; }
  if [[ $CONTEXT != start && $action != k ]]; then _terminal_proof_emit "$id;error;unsupported-context"; return; fi
  case $action in
    c)
      [[ $_terminal_proof_mode == fixed && -z $BUFFER ]] || { _terminal_proof_emit "$id;error;not-ready"; return; }
      {
        if (( $+widgets[zle-line-pre-redraw] )); then
          zle -A zle-line-pre-redraw _terminal_proof_saved_redraw
          zle -D zle-line-pre-redraw
          saved_redraw=1
        fi
        BUFFER=$decoded CURSOR=$cursor
        _terminal_proof_matches=0
        zle _terminal_proof_complete
        _terminal_proof_hex "$BUFFER"; result=$REPLY; position=$CURSOR
        (( ${#result} <= 8192 )) || failure=too-many-bytes
        _terminal_proof_options=() _terminal_proof_positions=()
        limit=$(( _terminal_proof_matches < 64 ? _terminal_proof_matches : 64 ))
        if (( _terminal_proof_matches == 1 )); then
          _terminal_proof_options+=("$BUFFER") _terminal_proof_positions+=("$CURSOR")
        else
          for (( i=1; i<=limit && ! ${#failure}; i++ )); do
            _terminal_proof_index=$i
            zle _terminal_proof_pick
            (( _terminal_proof_list_valid )) || { failure=completion-failed; break; }
            _terminal_proof_hex "$BUFFER"
            (( ${#REPLY} <= 8192 )) || { failure=too-many-bytes; break; }
            _terminal_proof_options+=("$BUFFER") _terminal_proof_positions+=("$CURSOR")
          done
        fi
      } always {
        BUFFER='' CURSOR=0
        if (( saved_redraw )); then
          zle -A _terminal_proof_saved_redraw zle-line-pre-redraw
          zle -D _terminal_proof_saved_redraw
        fi
      }
      [[ -z $failure ]] || { _terminal_proof_options=() _terminal_proof_positions=(); _terminal_proof_emit "$id;error;$failure"; return; }
      _terminal_proof_emit "$id;result;$position;$result"
      for (( i=1; i<=${#_terminal_proof_options}; i++ )); do
        _terminal_proof_hex "$_terminal_proof_options[i]"
        _terminal_proof_emit "$id;option;$i;$_terminal_proof_positions[i];$REPLY"
      done
      (( _terminal_proof_matches > 64 )) && _terminal_proof_emit "$id;truncated;$_terminal_proof_matches"
      _terminal_proof_emit "$id;done;$_terminal_proof_generation"
      _terminal_proof_options=() _terminal_proof_positions=()
      ;;
    s)
      [[ $_terminal_proof_mode == fixed && -z $BUFFER && -z $_terminal_proof_loaded ]] || { _terminal_proof_emit "$id;error;not-ready"; return; }
      BUFFER=$decoded CURSOR=$cursor
      PROMPT=$_terminal_proof_shelf_prompt
      zle reset-prompt
      _terminal_proof_loaded=$id
      _terminal_proof_emit "$id;loaded;$_terminal_proof_generation"
      ;;
    x)
      [[ $_terminal_proof_mode == fixed && -n $_terminal_proof_loaded && $decoded == $_terminal_proof_loaded ]] || { _terminal_proof_emit "$id;error;not-ready"; return; }
      BUFFER='' CURSOR=0 _terminal_proof_loaded='' PROMPT=''
      zle reset-prompt
      _terminal_proof_emit "$id;cancelled;$_terminal_proof_generation"
      ;;
    d)
      [[ $_terminal_proof_mode == fixed && -z $BUFFER && -z $_terminal_proof_loaded ]] || { _terminal_proof_emit "$id;error;not-ready"; return; }
      _terminal_proof_mode=direct PROMPT=$_terminal_proof_prompt RPROMPT=$_terminal_proof_rprompt
      BUFFER=$decoded CURSOR=$cursor
      zle reset-prompt
      zle -R
      _terminal_proof_emit "$id;direct;$_terminal_proof_generation"
      ;;
    g)
      [[ $_terminal_proof_mode == direct ]] || { _terminal_proof_emit "$id;error;not-ready"; return; }
      _terminal_proof_hex "$BUFFER"
      (( ${#REPLY} <= 8192 )) || { _terminal_proof_emit "$id;error;too-many-bytes"; return; }
      _terminal_proof_emit "$id;snapshot;$CURSOR;$REPLY;$_terminal_proof_generation"
      BUFFER='' CURSOR=0
      _terminal_proof_mode=fixed PROMPT='' RPROMPT=''
      zle reset-prompt
      zle -R
      ;;
    k)
      if [[ -n $_terminal_proof_loaded ]]; then BUFFER='' CURSOR=0 _terminal_proof_loaded='' PROMPT=''; zle reset-prompt; fi
      _terminal_proof_emit "$id;interrupt;$_terminal_proof_generation"
      ;;
  esac
}
_terminal_proof_extract() {
  local LC_ALL=C frame
  if [[ $_terminal_proof_pending == *$'\n'* ]]; then
    frame=${_terminal_proof_pending%%$'\n'*}
    _terminal_proof_pending=${_terminal_proof_pending#*$'\n'}
    if (( _terminal_proof_discard )); then _terminal_proof_discard=0; return 3; fi
    (( ${#frame} <= 16384 )) || return 2
    REPLY=$frame
    return 0
  fi
  if (( _terminal_proof_discard )); then _terminal_proof_pending=''; return 1; fi
  if (( ${#_terminal_proof_pending} > 16384 )); then
    _terminal_proof_pending='' _terminal_proof_discard=1
    return 2
  fi
  return 1
}
_terminal_proof_dispatch() {
  local chunk frame
  local -i extract_status count=0 read_status
  local -F deadline remaining
  (( _terminal_proof_fd_number >= 0 )) || return
  deadline=$(( EPOCHREALTIME + 1.0 ))
  while (( count++ < 16386 )); do
    _terminal_proof_extract
    extract_status=$?
    case $extract_status in
      0) frame=$REPLY; _terminal_proof_process "$frame"; return ;;
      2)
        _terminal_proof_emit '0;error;invalid-frame'
        (( _terminal_proof_discard )) || return
        ;;
      3) return ;;
    esac
    (( _terminal_proof_fd_number >= 0 )) || return
    remaining=$(( deadline - EPOCHREALTIME ))
    (( remaining > 0 )) || { _terminal_proof_disconnect; return; }
    sysread -i $_terminal_proof_fd_number -s 16384 -t $remaining chunk
    read_status=$?
    (( read_status == 0 )) || { _terminal_proof_disconnect; return; }
    _terminal_proof_pending+=$chunk
  done
  _terminal_proof_disconnect
}
zle -N _terminal_proof_dispatch
for _terminal_proof_map in main emacs viins vicmd; do
  if bindkey -M $_terminal_proof_map >/dev/null 2>&1; then
    bindkey -M $_terminal_proof_map "$PI_DESKTOP_TERMINAL_DISPATCH" _terminal_proof_dispatch
  fi
done
unset _terminal_proof_map PI_DESKTOP_TERMINAL_DISPATCH
